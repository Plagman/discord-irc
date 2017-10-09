import logger from 'winston';
/*
  Purging class, that will remove out of date messages from the channel.

  config sample (to add to bot config):

  "purge": {
    "purgeTimerInterval": 10000,  // timer tick of the purge callback,
                                  // will grow if messages arent processed when timer starts
    "watcherInterval": 5000,      // timer tick of the discord channel messages fetching
    "purgeCountPerRound": 15,     // number of messages deleted by round
    "messageLifeTime": {          // messages lifetime config, will be added to message.CreatedAt.
      "days": 2,
      "hours": 3,
      "minutes": 1,
      "seconds": 1,
    }
  }
*/
class Purge {
  constructor(config) {
    this.config = config;
    this.messageQueue = [];
    this.sas = [];
    this.stats = {
      itemsDeleted: 0,
      itemsDeletedCalled: 0,
      errors: 0
    };
  }

  start() {
    setTimeout(this.purgeTimerWatch.bind(this), this.config.purgeTimerInterval);
  }

  continue(timeout = this.config.purgeTimerInterval) {
    setTimeout(this.purgeTimerWatch.bind(this), timeout, this);
  }

  purgeTimerWatch() {
    const now = new Date();
    let i = 0;

    // logger.info(`>>> purge count: ${this.messageQueue.length}`);
    // logger.info(`>>> deleting: ${this.stats.itemsDeletedCalled}`);
    // logger.info(`>>> deleted: ${this.stats.itemsDeleted}`);
    // logger.info(`>>>  errors: ${this.stats.errors}`);

    // // we're not done receiving responses from previous batch, so we wait
    if (this.sas.length > 0) {
      this.config.purgeTimerInterval +=
        this.config.purgeTimerInterval * (this.sas.length / this.config.purgeCountPerRound);
      this.continue(this.sas.length / this.config.purgeCountPerRound);
      // logger.info(`purge timer is now : ${this.config.purgeTimerInterval / 1000}`);
      return;
    }

    // process the ${config.purgeCountPerRound} first elements (by dueDate)
    for (i = 0; i < this.config.purgeCountPerRound; i += 1) {
      const tuple = this.messageQueue
        .filter(t => this.sas.findIndex(s => s.message.id === t.message.id) === -1)
        .filter(t => t.dueDate < now)
        .sort((left, right) => left.dueDate - right.dueDate)[i]; // meh

      if (tuple) {
        tuple.message.delete()
          .then(() => {
            // logger.info(`<< deleted : ${tuple.message.content}`);
            this.stats.itemsDeleted += 1;
            this.removeFromStores(tuple);
          },
            (err) => {
              logger.error(`<< error : ${err} | ${tuple.message.content}`);
              this.stats.errors += 1;
              this.removeFromStores(tuple);
            });
        // logger.info(`>> deleting : ${tuple.message.content}`);
        this.stats.itemsDeletedCalled += 1;
        this.sas.push(tuple);
      }
    }
    this.continue();
  }


  removeFromStores(tuple) {
    let index = this.messageQueue.findIndex(t => t.message.id === tuple.message.id);
    if (index !== -1) {
      this.messageQueue.splice(index, 1);
    }
    index = this.sas.findIndex(t => t.message.id === tuple.message.id);
    if (index !== -1) {
      this.sas.splice(index, 1);
    }
  }

  getOldestMessageInQueue() {
    const tuple = this.messageQueue.sort((left, right) => left.dueDate - right.dueDate)[0];
    return tuple == null ? null : tuple.message;
  }

  addMessage(message, dueDate) {
    const due = dueDate;
    // const now = new Date();

    if (this.messageQueue.findIndex(t => t.message.id === message.id) === -1) {
      // logger.info(`>> sending msg to purge: ${message.content}`);
      this.messageQueue.push({
        dueDate: due,
        message,
      });
    }
  }
}
export default Purge;
