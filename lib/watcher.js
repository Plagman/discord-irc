import logger from 'winston';

/*
  Watcher class, that fetches messages from the configured channels (in channel mappings)
  and sends them to be purged.
  See purge.js for detailled config.
*/
class Watcher {
  constructor(purger, discordClient, config, channelMappings) {
    this.purge = purger;
    this.discord = discordClient;
    this.mappings = channelMappings;
    this.config = config;
    this.discord.on('ready', this.start.bind(this));
  }

  start() {
    const chans =
      Object.values(this.mappings)
      .map(m =>
        (m.startsWith('#') ? this.discord.channels.filter(c => c.type === 'text')
          .find('name', m.slice(1)) :
          this.discord.channels.get(m))
      )
      .filter(c => c !== null);

    this.chans = chans;
    this.lifeTimeOffset = Watcher.getLifeTimeOffset(this.config.messageLifeTime);
    setInterval(this.watcherTicker.bind(this), this.config.watcherInterval, this);
  }

  watcherTicker() {
    this.chans.forEach(chan =>
      chan.fetchMessages(this.fetchParams())
      .then(messages =>
        messages.forEach(msg =>
          this.sendToPurge(msg)
        ),
        err => logger.error(`error fetching messages : ${err}`)
      )
    );
  }

  fetchParams() {
    const oldest = this.purge.getOldestMessageInQueue();
    if (oldest == null) {
      return {
        limit: 50,
      };
    }
    return {
      before: oldest.id,
      limit: 50,
    };
  }

  sendToPurge(message) {
    const date = new Date(message.createdAt.getTime() + this.lifeTimeOffset);
    this.purge.addMessage(message, date);
  }

  onDiscordMessage(message) {
    if (this.chans.find(c => c === message.channel) != null) {
      this.sendToPurge(message);
    }
  }

  static getLifeTimeOffset(lt = { }) {
    let seconds = 0;
    seconds += (lt.days ? lt.days : 0) * 24 * 60 * 60;
    seconds += (lt.hours ? lt.hours : 0) * 60 * 60;
    seconds += (lt.minutes ? lt.minutes : 0) * 60;
    seconds += (lt.seconds ? lt.seconds : 0);
    return seconds * 1000;
  }
}

export default Watcher;
