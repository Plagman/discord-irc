import _ from 'lodash';
import irc from 'irc-upd';
import logger from 'winston';
import discord from 'discord.js';
import {
  ConfigurationError
} from './errors';
import {
  validateChannelMapping
} from './validators';
import {
  formatFromDiscordToIRC,
  formatFromIRCToDiscord
} from './formatting';
import Purge from './purge';
import Watcher from './watcher';

const REQUIRED_FIELDS = ['server', 'nickname', 'channelMapping', 'discordToken'];
const NICK_COLORS = ['light_blue', 'dark_blue', 'light_red', 'dark_red', 'light_green',
  'dark_green', 'magenta', 'light_magenta', 'orange', 'yellow', 'cyan', 'light_cyan'
];
const patternMatch = /{\$(.+?)}/g;

/**
 * An IRC bot, works as a middleman for all communication
 * @param {object} options - server, nickname, channelMapping, outgoingToken, incomingURL
 */
class Bot {
  constructor(options) {
    REQUIRED_FIELDS.forEach((field) => {
      if (!options[field]) {
        throw new ConfigurationError(`Missing configuration field ${field}`);
      }
    });

    validateChannelMapping(options.channelMapping);

    this.discord = new discord.Client({
      autoReconnect: true
    });

    this.server = options.server;
    this.nickname = options.nickname;
    this.ircOptions = options.ircOptions;
    this.discordToken = options.discordToken;
    this.commandCharacters = options.commandCharacters || [];
    this.ircNickColor = options.ircNickColor !== false; // default to true
    this.channels = _.values(options.channelMapping);
    this.ircStatusNotices = options.ircStatusNotices;
    this.announceSelfJoin = options.announceSelfJoin;

    this.goldenGate = options.goldenGate || {};


    // "{$keyName}" => "variableValue"
    // author/nickname: nickname of the user who sent the message
    // discordChannel: Discord channel (e.g. #general)
    // ircChannel: IRC channel (e.g. #irc)
    // text: the (appropriately formatted) message content
    this.format = options.format || {};

    // "{$keyName}" => "variableValue"
    // displayUsername: nickname with wrapped colors
    // attachmentURL: the URL of the attachment (only applicable in formatURLAttachment)
    this.formatIRCText = this.format.ircText || '<{$displayUsername}> {$text}';
    this.formatURLAttachment = this.format.urlAttachment || '<{$displayUsername}> {$attachmentURL}';
    // "{$keyName}" => "variableValue"
    // side: "Discord" or "IRC"
    if ('commandPrelude' in this.format) {
      this.formatCommandPrelude = this.format.commandPrelude;
    } else {
      this.formatCommandPrelude = 'Command sent from {$side} by {$nickname}:';
    }

    // "{$keyName}" => "variableValue"
    // withMentions: text with appropriate mentions reformatted
    this.formatDiscord = this.format.discord || '**<{$author}>** {$withMentions}';

    // Keep track of { channel => [list, of, usernames] } for ircStatusNotices
    this.channelUsers = {};

    this.channelMapping = {};

    // Remove channel passwords from the mapping and lowercase IRC channel names
    _.forOwn(options.channelMapping, (ircChan, discordChan) => {
      this.channelMapping[discordChan] = ircChan.split(' ')[0].toLowerCase();
    });

    this.invertedMapping = _.invert(this.channelMapping);
    this.autoSendCommands = options.autoSendCommands || [];

    if (options.purge) {
      this.purger = new Purge(options.purge);
      this.purger.start();
      this.watcher = new Watcher(this.purger, this.discord, options.purge, this.channelMapping);
    }


    this.ircClients = {};
  }

  connect() {
    // logger.level = 'debug';
    logger.debug('Connecting to IRC and Discord');
    this.discord.login(this.discordToken);

    const ircOptions = {
      userName: this.nickname,
      realName: this.nickname,
      channels: this.channels,
      floodProtection: true,
      floodProtectionDelay: 500,
      retryCount: 10,
      ...this.ircOptions
    };

    this.ircClient = new irc.Client(this.server, this.nickname, ircOptions);
    this.attachListeners();
  }

  attachListeners() {
    this.discord.on('ready', () => {
      logger.info('<discord> Connected to Discord');
      if (this.goldenGate.enabled || false) {
        this.createIrcConnections();
      }
    });

    this.ircClient.on('registered', (message) => {
      logger.info('<irc> Connected to IRC');
      logger.debug('<irc> Registered event: ', message);
      this.autoSendCommands.forEach((element) => {
        this.ircClient.send(...element);
      });
    });

    this.ircClient.on('error', (error) => {
      logger.error('<irc> Received error event from IRC', error);
    });

    this.discord.on('error', (error) => {
      logger.error('<discord> Received error event from Discord', error);
    });

    this.discord.on('warn', (warning) => {
      logger.warn('<discord> Received warn event from Discord', warning);
    });

    this.discord.on('message', (message) => {
      // Ignore bot messages and people leaving/joining
      this.sendToIRC(message);
    });

    this.ircClient.on('message', this.sendToDiscord.bind(this));

    this.ircClient.on('notice', (author, to, text) => {
      this.sendToDiscord(author, to, `*${text}*`);
    });

    this.ircClient.on('nick', (oldNick, newNick, channels) => {
      if (!this.ircStatusNotices) return;


      channels.forEach((channelName) => {
        const channel = channelName.toLowerCase();
        if (this.channelUsers[channel]) {
          if (this.channelUsers[channel].has(oldNick)) {
            this.channelUsers[channel].delete(oldNick);
            this.channelUsers[channel].add(newNick);

            if (this.isHandledClient([oldNick, newNick])) return;

            this.sendExactToDiscord(channel, `*${oldNick}* is now known as ${newNick}`);
          }
        } else {
          logger.warn(`<irc> No channelUsers found for ${channel} when ${oldNick} changed.`);
        }
      });
    });

    this.ircClient.on('join', (channelName, nick) => {
      logger.debug('<irc> Received join:', channelName, nick);
      if (!this.ircStatusNotices) return;
      if (nick === this.ircClient.nick && !this.announceSelfJoin) return;
      const channel = channelName.toLowerCase();
      // self-join is announced before names (which includes own nick)
      // so don't add nick to channelUsers
      if (nick !== this.ircClient.nick) this.channelUsers[channel].add(nick);

      if (this.isHandledClient([nick])) return;
      this.sendExactToDiscord(channel, `*${nick}* has joined the channel`);
    });

    this.ircClient.on('part', (channelName, nick, reason) => {
      logger.debug('<irc> Received part:', channelName, nick, reason);
      if (!this.ircStatusNotices) return;
      const channel = channelName.toLowerCase();
      // remove list of users when no longer in channel (as it will become out of date)
      if (nick === this.ircClient.nick) {
        logger.debug('<irc> Deleting channelUsers as bot parted:', channel);
        delete this.channelUsers[channel];
        return;
      }
      if (this.channelUsers[channel]) {
        this.channelUsers[channel].delete(nick);
      } else {
        logger.warn(`<irc> No channelUsers found for ${channel} when ${nick} parted.`);
      }

      if (this.isHandledClient([nick])) return;
      this.sendExactToDiscord(channel, `*${nick}* has left the channel (${reason})`);
    });

    this.ircClient.on('quit', (nick, reason, channels) => {
      logger.debug('<irc> Received quit:', nick, channels);
      if (!this.ircStatusNotices || nick === this.ircClient.nick) return;
      channels.forEach((channelName) => {
        const channel = channelName.toLowerCase();
        if (!this.channelUsers[channel]) {
          logger.warn(`<irc> No channelUsers found for ${channel} when ${nick} quit, ignoring.`);
          return;
        }
        if (!this.channelUsers[channel].delete(nick)) return;

        if (this.isHandledClient([nick])) return;
        this.sendExactToDiscord(channel, `*${nick}* has quit (${reason})`);
      });
    });

    this.ircClient.on('names', (channelName, nicks) => {
      logger.debug('<irc> Received names:', channelName, nicks);
      if (!this.ircStatusNotices) return;
      const channel = channelName.toLowerCase();
      this.channelUsers[channel] = new Set(Object.keys(nicks));
    });

    this.ircClient.on('action', (author, to, text) => {
      this.sendToDiscord(author, to, `_${text}_`);
    });

    this.ircClient.on('invite', (channel, from) => {
      logger.debug('<irc> Received invite:', channel, from);
      if (!this.invertedMapping[channel]) {
        logger.debug('<irc> Channel not found in config, not joining:', channel);
      } else {
        this.ircClient.join(channel);
        logger.debug('<irc> Joining channel:', channel);
      }
    });

    if (logger.level === 'debug') {
      this.discord.on('debug', (message) => {
        logger.debug('<discord> Received debug event from Discord', message);
      });
    }

    this.discord
      .on('guildMemberUpdate', (oldGM, newGM) => {
        logger.debug(`<discord> guildMemberUpdate old: ${oldGM.displayName} -> new ${oldGM.displayName}`);
        if (oldGM.displayName !== newGM.displayName) {
          this.renameIrcUser(newGM);
        }
      })
      .on('presenceUpdate', (oldGM, newGM) => {
        logger.debug(`<discord> presenceUpdate old: ${oldGM.presence.status} -> new ${oldGM.presence.status}`);
        if (oldGM.presence.status !== newGM.presence.status) {
          this.renameIrcUser(newGM);
        }
      })
    // .on('userUpdate', (oldUser, newUser) => {
    //   logger.debug(`<discord> userUpdate old: ${oldUser.username} -> new ${newUser.username}`);
    // })
    ;
  }

  static getDiscordNicknameOnServer(user, guild) {
    const userDetails = guild.members.get(user.id);
    if (userDetails) {
      return userDetails.nickname || user.username;
    }
    return user.username;
  }

  parseText(message) {
    const text = message.mentions.users.reduce((content, mention) => {
      const displayName = Bot.getDiscordNicknameOnServer(mention, message.guild);
      return content.replace(`<@${mention.id}>`, `@${displayName}`)
        .replace(`<@!${mention.id}>`, `@${displayName}`)
        .replace(`<@&${mention.id}>`, `@${displayName}`);
    }, message.content);

    return text
      .replace(/\n|\r\n|\r/g, ' ')
      .replace(/<#(\d+)>/g, (match, channelId) => {
        const channel = this.discord.channels.get(channelId);
        if (channel) return `#${channel.name}`;
        return '#deleted-channel';
      })
      .replace(/<@&(\d+)>/g, (match, roleId) => {
        const role = message.guild.roles.get(roleId);
        if (role) return `@${role.name}`;
        return '@deleted-role';
      })
      .replace(/<(:\w+:)\d+>/g, (match, emoteName) => emoteName);
  }

  isCommandMessage(message) {
    return this.commandCharacters.indexOf(message[0]) !== -1;
  }

  static substitutePattern(message, patternMapping) {
    return message.replace(patternMatch, (match, varName) => patternMapping[varName] || match);
  }

  sendToIRC(message) {
    const author = message.author;
    // Ignore messages sent by the bot itself:
    if (author.id === this.discord.user.id) return;


    const channelName = `#${message.channel.name}`;
    const ircChannel = this.channelMapping[message.channel.id] ||
      this.channelMapping[channelName];

    if (this.ircClients[author.id] != null) {
      this.sendFromClient(author, ircChannel, message);
      return;
    }


    logger.debug('<discord> Channel Mapping', channelName, this.channelMapping[channelName]);
    if (ircChannel) {
      const fromGuild = message.guild;
      const nickname = Bot.getDiscordNicknameOnServer(author, fromGuild);
      let text = this.parseText(message);
      let displayUsername = nickname;
      if (this.ircNickColor) {
        const colorIndex = (nickname.charCodeAt(0) + nickname.length) % NICK_COLORS.length;
        displayUsername = irc.colors.wrap(NICK_COLORS[colorIndex], nickname);
      }

      const patternMap = {
        author: nickname,
        nickname,
        displayUsername,
        text,
        discordChannel: channelName,
        ircChannel
      };

      if (this.isCommandMessage(text)) {
        patternMap.side = 'Discord';
        logger.debug('<discord> Sending command message to IRC', ircChannel, text);
        // if (prelude) this.ircClient.say(ircChannel, prelude);
        if (this.formatCommandPrelude) {
          const prelude = Bot.substitutePattern(this.formatCommandPrelude, patternMap);
          this.ircClient.say(ircChannel, prelude);
        }
        this.ircClient.say(ircChannel, text);
      } else {
        if (text !== '') {
          // Convert formatting
          text = formatFromDiscordToIRC(text);
          patternMap.text = text;

          text = Bot.substitutePattern(this.formatIRCText, patternMap);
          logger.debug('<discord> Sending message to IRC', ircChannel, text);
          this.ircClient.say(ircChannel, text);
        }

        if (message.attachments && message.attachments.size) {
          message.attachments.forEach((a) => {
            patternMap.attachmentURL = a.url;
            const urlMessage = Bot.substitutePattern(this.formatURLAttachment, patternMap);

            logger.debug('<discord> Sending attachment URL to IRC', ircChannel, urlMessage);
            this.ircClient.say(ircChannel, urlMessage);
          });
        }
      }
    }
  }

  findDiscordChannel(ircChannel) {
    const discordChannelName = this.invertedMapping[ircChannel.toLowerCase()];
    if (discordChannelName) {
      // #channel -> channel before retrieving and select only text channels:
      const discordChannel = discordChannelName.startsWith('#') ? this.discord.channels
        .filter(c => c.type === 'text')
        .find('name', discordChannelName.slice(1)) : this.discord.channels.get(discordChannelName);

      if (!discordChannel) {
        logger.info('<irc> Tried to send a message to a channel the bot isn\'t in: ',
          discordChannelName);
        return null;
      }
      return discordChannel;
    }
    return null;
  }

  sendToDiscord(author, channel, text) {
    const discordChannel = this.findDiscordChannel(channel);

    if (!discordChannel) return;

    if (_.values(this.ircClients)
      .some(cli => cli.nick === author)) {
      return;
    }

    // Convert text formatting (bold, italics, underscore)
    const withFormat = formatFromIRCToDiscord(text);

    const patternMap = {
      author,
      nickname: author,
      text: withFormat,
      discordChannel: `#${discordChannel.name}`,
      ircChannel: channel
    };

    if (this.isCommandMessage(text)) {
      patternMap.side = 'IRC';
      logger.debug('<irc> Sending command message to Discord', `#${discordChannel.name}`, text);
      if (this.formatCommandPrelude) {
        const prelude = Bot.substitutePattern(this.formatCommandPrelude, patternMap);
        discordChannel.send(prelude);
      }
      discordChannel.send(text);
      return;
    }

    let newString = withFormat;

    discordChannel.members.forEach((member) => {
      const reg = new RegExp(member.displayName, 'gi');
      newString = newString.replace(reg, () => `<@!${member.id}>`);
    });

    const withMentions = newString;

    patternMap.withMentions = withMentions;

    // Add bold formatting:
    // Use custom formatting from config / default formatting with bold author
    const withAuthor = Bot.substitutePattern(this.formatDiscord, patternMap);
    logger.debug('<irc> Sending message to Discord', withAuthor, channel, '->', `#${discordChannel.name}`);
    discordChannel.send(withAuthor);
  }

  /* Sends a message to Discord exactly as it appears */
  sendExactToDiscord(channel, text) {
    const discordChannel = this.findDiscordChannel(channel);
    if (!discordChannel) return;

    logger.debug('<irc> Sending special message to Discord', text, channel, '->', `#${discordChannel.name}`);
    discordChannel.send(text);
  }

  createIrcConnections() {
    let i = 0;
    this.discord.guilds
      .filter(guild =>
        guild.channels.some(chan =>
          Object.values(this.channelMapping)
          .some(cm => cm === `#${chan.name}`)))
      .map(guild => guild.members)
      .reduce((users, it) => users.concat(it))
      .filter(gm => !(gm.user.bot || false))
      .forEach((gm) => {
        if (this.ircClients[gm.user.id] == null) {
          const nickName = Bot.getIrcName(gm);
          const userName = gm.user.username;
          const ircOptions = {
            userName: nickName,
            realName: userName,
            channels: this.channels,
            floodProtection: true,
            floodProtectionDelay: 500,
            retryCount: 10,
            ...this.ircOptions
          };
          if (i > (this.goldenGate.maxIrcConnections || 2)) return;
          i += 1;
          const ircUser = new irc.Client(this.server, nickName, ircOptions);

          this.ircClients[gm.user.id] = ircUser;
          ircUser.on('registered', (msg) => {
            logger.debug(`<irc> irc user ${userName} connected: ${msg}`);
          });
        }
      });
  }

  isHandledClient(nickTab = []) {
    const b = nickTab.some(nick =>
      _.values(this.ircClients)
      .some(cli => cli.nick === nick)
    );
    return b;
  }

  sendFromClient(who, ircChannel, message) {
    const client = this.ircClients[who.id];

    if (ircChannel) {
      client.say(ircChannel, message.content);
    } else {
      logger.error(`message has no ircChannel ${message}`);
    }
  }

  renameIrcUser(guildMember) {
    const ircClient = this.ircClients[guildMember.user.id];
    const nick = Bot.getIrcName(guildMember);
    if (ircClient) {
      ircClient.nick = nick;
      ircClient.send('NICK', nick);
    }
  }

  static getIrcName(guildMember) {
    const name = guildMember.displayName || guildMember.user.username;
    let suffix = '';
    if (guildMember.presence.status === 'offline') {
      suffix = '_off';
    } else if (guildMember.presence.status === 'idle') {
      suffix = '_aw';
    } else if (guildMember.presence.status === 'dnd') {
      suffix = '_dnd';
    }
    return name + suffix;
  }
}

export default Bot;
