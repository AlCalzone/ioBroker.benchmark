import * as utils from '@iobroker/adapter-core';
import pidusage from 'pidusage';
import {testObjects} from './lib/helper';
import {tests as allTests} from './lib/allTests';
import Timeout = NodeJS.Timeout;

interface RequestedMonitoringEntry {
	time: number[];
	cpuStats: number[],
	memStats: number[],
	eventLoopLags: number[]
}

interface SummaryState {
	secondaries?: Record<string, SummaryState>,
	timeMean: number,
	timeStd: number,
	memMean: number,
	memStd: number,
	cpuMean: number,
	cpuStd: number,
	eventLoopLagMean: number,
	eventLoopLagStd: number,
	actionsPerSecondMean: number,
	actionsPerSecondStd: number
}

class Benchmark extends utils.Adapter {
	private activeTest: string;
	private memStats: Record<string, number[]>;
	private cpuStats: Record<string, number[]>;
	private restartInstances: string[] | undefined;
	private monitoringActive: boolean;
	private internalEventLoopLags: Record<string, number[]>;
	private requestedMonitoring: Record<string, RequestedMonitoringEntry>;
	private requestedMonitoringStartTime: [number, number] | undefined;

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: 'benchmark'
		});

		this.on('ready', this.onReady.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));

		this.activeTest = 'none';
		this.monitoringActive = false;
		this.memStats = {};
		this.cpuStats = {};
		this.internalEventLoopLags = {};
		this.requestedMonitoring = {};
	}

	/**
     * Is called when databases are connected and adapter received configuration.
     */
	private async onReady(): Promise<void> {
		// everything message based right now
	}

	/**
     * Execute the tests for a non secondary adapter
     * @private
     */
	private async runTests(selectedTests:Record<string, any>): Promise<void> {
		// stop all instances if isolated run
		if (this.config.isolatedRun) {
			this.restartInstances = [];
			this.log.info('Isolated run, stopping all instances');
			const instancesObj = await this.getObjectViewAsync('system', 'instance', {startkey: '', endkey: '\u9999'});
			for (const instance of instancesObj.rows) {
				if (instance.id !== `system.adapter.${this.namespace}` && instance.value?.common?.enabled) {
					// stop instances except own
					instance.value.common.enabled = false;
					await this.setForeignObjectAsync(instance.id, instance.value);
					this.restartInstances.push(instance.id);
				}
			}
		}

		this.config.iterations = this.config.iterations || 10000;
		this.config.epochs = this.config.epochs || 5;

		this.memStats = {};
		this.cpuStats = {};
		this.internalEventLoopLags = {};
		this.requestedMonitoring = {};

		const times: Record<string, number[]> = {};

		// monitor stats up from the beginning
		this.monitoringActive = true;
		this.monitorStats();
		this.measureEventLoopLag(50, lag => {
			if (this.activeTest !== 'none') {
				this.internalEventLoopLags[this.activeTest].push(lag);
			}
		});

		this.log.info('Starting benchmark test...');

		for (const activeTestName of Object.keys(selectedTests)) {
			times[activeTestName] = [];
			this.cpuStats[activeTestName] = [];
			this.memStats[activeTestName] = [];
			this.internalEventLoopLags[activeTestName] = [];

			await this.setObjectNotExistsAsync(activeTestName, {
				type: 'channel',
				common: {
					name: `Test ${activeTestName}`
				},
				native: {}
			});

			// create objects for this test
			for (const obj of testObjects) {
				const origId = obj._id;
				obj._id = `${this.namespace}.${activeTestName}.${obj._id}`;
				await this.setForeignObjectNotExistsAsync(obj._id, obj);
				// reset id
				obj._id = origId;
			}

			this.log.info(`Starting test "${activeTestName}"`);
			// execute each test epochs time
			for (let j = 1; j <= this.config.epochs; j++) {

				const activeTestConstructor = allTests[activeTestName];
				const activeTest = new activeTestConstructor(this);

				// prepare the test
				await activeTest.prepare();

				// only measure real execution
				this.activeTest = activeTestName;

				const timeStart = process.hrtime();

				await activeTest.execute();

				const timeEnd = parseFloat(process.hrtime(timeStart).join('.'));

				this.activeTest = 'none';

				times[activeTestName].push(timeEnd);

				await activeTest.cleanUp();

				this.log.info(`Epoch ${j} finished in ${timeEnd} s - starting 30 s cooldown`);
				// wait 30 sec to "cooldown" system
				await this.wait(30000);
			}

			// set states - TIME
			const timeMean = this.round(this.calcMean(times[activeTestName]));
			const timeStd = this.round(this.calcStd(times[activeTestName]));

			await this.setStateAsync(`${activeTestName}.timeMean`, timeMean, true);
			await this.setStateAsync(`${activeTestName}.timeStd`, timeStd, true);

			// set states - CPU
			const cpuMean = this.round(this.calcMean(this.cpuStats[activeTestName]));
			const cpuStd = this.round(this.calcStd(this.cpuStats[activeTestName]));

			await this.setStateAsync(`${activeTestName}.cpuMean`, cpuMean, true);
			await this.setStateAsync(`${activeTestName}.cpuStd`, cpuStd, true);

			// set states - MEM
			const memMean = this.round(this.calcMean(this.memStats[activeTestName]));
			const memStd = this.round(this.calcStd(this.memStats[activeTestName]));

			await this.setStateAsync(`${activeTestName}.memMean`, memMean, true);
			await this.setStateAsync(`${activeTestName}.memStd`, memStd, true);

			// set states - event loop lag
			const eventLoopLagMean = this.round(this.calcMean(this.internalEventLoopLags[activeTestName]));
			const eventLoopLagStd = this.round(this.calcStd(this.internalEventLoopLags[activeTestName]));

			await this.setStateAsync(`${activeTestName}.eventLoopLagMean`, eventLoopLagMean, true);
			await this.setStateAsync(`${activeTestName}.eventLoopLagStd`, eventLoopLagStd, true);

			const actionsPerSecondMean = this.round(this.config.iterations / timeMean);
			const actionsPerSecondStd = timeStd !== 0 ? this.round(this.config.iterations / timeStd) : 0;

			await this.setStateAsync(`${activeTestName}.actionsPerSecondMean`, actionsPerSecondMean, true);
			await this.setStateAsync(`${activeTestName}.actionsPerSecondStd`, actionsPerSecondStd , true);

			const summaryState: SummaryState = {
				timeMean,
				timeStd,
				cpuMean,
				cpuStd,
				memMean,
				memStd,
				eventLoopLagMean,
				eventLoopLagStd,
				actionsPerSecondMean,
				actionsPerSecondStd
			};

			// check all requested monitoring
			for (const instance of Object.keys(this.requestedMonitoring)) {
				summaryState.secondaries = summaryState.secondaries || {};
				const timeMean = this.round(this.calcMean(this.requestedMonitoring[instance].time));
				const timeStd = this.round(this.calcStd(this.requestedMonitoring[instance].time));

				summaryState.secondaries[instance] = {
					cpuMean:this.round(this.calcMean(this.requestedMonitoring[instance].cpuStats)),
					cpuStd: this.round(this.calcStd(this.requestedMonitoring[instance].cpuStats)),
					memMean: this.round(this.calcMean(this.requestedMonitoring[instance].memStats)),
					memStd: this.round(this.calcStd(this.requestedMonitoring[instance].memStats)),
					eventLoopLagMean: this.round(this.calcMean(this.requestedMonitoring[instance].eventLoopLags)),
					eventLoopLagStd: this.round(this.calcStd(this.requestedMonitoring[instance].eventLoopLags)),
					timeMean,
					timeStd,
					actionsPerSecondMean: this.round(this.config.iterations / timeMean / Object.keys(this.requestedMonitoring).length), // actions are split on all instances
					actionsPerSecondStd: timeStd !== 0 ? this.round(this.config.iterations / timeStd / Object.keys(this.requestedMonitoring).length) : 0
				};
			}

			await this.setStateAsync(`${activeTestName}.summary`, JSON.stringify(summaryState), true);

			// clear RAM
			delete this.cpuStats[activeTestName];
			delete this.memStats[activeTestName];
			delete this.internalEventLoopLags[activeTestName];
			this.requestedMonitoring = {};
		}

		// we can stop the monitoring procedure
		this.monitoringActive = false;

		if (this.config.isolatedRun && this.restartInstances) {
			this.log.info('Restarting instances ...');
			for (const id of this.restartInstances) {
				const obj = await this.getForeignObjectAsync(id);
				if (obj && obj.common) {
					obj.common.enabled = true;
					await this.setForeignObjectAsync(id, obj);
				}
			}
		}

		this.log.info('Finished benchmark...');
	}

	/**
     * As secondary we want to listen to messages for tests
     */
	private async onMessage(obj: ioBroker.Message): Promise<void> {
		// only secondary mode instances need to response to messages
		if (!this.config.secondaryMode) {
			if (obj.command === 'test') {
				// run all tests on test command - do not await, we want to respond to message
				this.runTests(allTests);
			} else if (allTests[obj.command]) {
				const selectedTests:Record<string, any> = {};
				selectedTests[obj.command] = allTests[obj.command];
				this.runTests(selectedTests);
			} else if (obj.command === 'requestedMonitoring') {
				// we have received a requested monitoring
				if (!this.requestedMonitoring[obj.from]) {
					this.requestedMonitoring[obj.from] = {cpuStats: [], memStats: [], eventLoopLags: [], time: []};
				}

				if (typeof obj.message === 'object' && Array.isArray(obj.message.cpuStats)) {
					this.requestedMonitoring[obj.from].cpuStats = [...this.requestedMonitoring[obj.from].cpuStats, ...obj.message.cpuStats];
				}

				if (typeof obj.message === 'object' && Array.isArray(obj.message.memStats)) {
					this.requestedMonitoring[obj.from].memStats = [...this.requestedMonitoring[obj.from].memStats, ...obj.message.memStats];
				}

				if (typeof obj.message === 'object' && Array.isArray(obj.message.eventLoopLags)) {
					this.requestedMonitoring[obj.from].eventLoopLags = [...this.requestedMonitoring[obj.from].eventLoopLags, ...obj.message.eventLoopLags];
				}

				if (typeof obj.message === 'object' && Array.isArray(obj.message.time)) {
					this.requestedMonitoring[obj.from].time = [...this.requestedMonitoring[obj.from].time, ...obj.message.time];
				}
			} else {
				this.log.warn(`Unknown message: ${JSON.stringify(obj)}`);
			}
		} else {
			// we run in secondary mode
			switch (obj.command) {
				case 'objects':
					if (typeof obj.message === 'object') {
						if (obj.message.cmd === 'set' && typeof obj.message.n === 'number') {
							for (let i = 0; i < obj.message.n; i++) {
								await this.setObjectAsync(`test.${i}`, {
									'type': 'state',
									'common': {
										name: i.toString(),
										read: true,
										write: true,
										role: 'state',
										type: 'number'
									},
									native: {}
								});
							}
						} else if (obj.message.cmd === 'del' && typeof obj.message.n === 'number') {
							for (let i = 0; i < obj.message.n; i++) {
								await this.delObjectAsync(`test.${i}`);
							}
						}
					}
					break;
				case 'states':
					if (typeof obj.message === 'object') {
						if (obj.message.cmd === 'set' && typeof obj.message.n === 'number') {
							// set states
							for (let i = 0; i < obj.message.n; i++) {
								await this.setStateAsync(`test.${i}`, i, true);
							}
						} else if (obj.message.cmd === 'del' && typeof obj.message.n === 'number') {
							for (let i = 0; i < obj.message.n; i++) {
								await this.delStateAsync(`test.${i}`);
							}
						}
					}
					break;
				case 'startMeasuring':
					this.activeTest = 'requestedMonitoring';
					this.monitoringActive = true;
					this.cpuStats.requestedMonitoring = [];
					this.memStats.requestedMonitoring = [];
					this.internalEventLoopLags.requestedMonitoring = [];
					this.requestedMonitoringStartTime = process.hrtime();

					this.monitorStats();
					this.measureEventLoopLag(50, lag => {
						if (this.activeTest !== 'none') {
							this.internalEventLoopLags[this.activeTest].push(lag);
						}
					});
					break;
				case 'stopMeasuring':
					this.activeTest = 'none';
					this.monitoringActive = false;
					// send report to controlling instance
					if (this.requestedMonitoringStartTime) {
						// we shouldn't receive a stop measuring if none has been started
						const obj: RequestedMonitoringEntry = {
							eventLoopLags: this.internalEventLoopLags.requestedMonitoring,
							memStats: this.memStats.requestedMonitoring,
							cpuStats: this.cpuStats.requestedMonitoring,
							time: [parseFloat(process.hrtime(this.requestedMonitoringStartTime).join('.'))]
						};

						await this.sendToAsync('benchmark.0', 'requestedMonitoring', obj);
					}
					// free ram
					delete this.internalEventLoopLags.requestedMonitoring;
					delete this.memStats.requestedMonitoring;
					delete this.cpuStats.requestedMonitoring;
					delete this.requestedMonitoringStartTime;
					break;
			}
		}

		// answer to resolve the senders promise
		this.sendTo(obj.from, obj.command, {}, obj.callback);
	}

	/**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
	private onUnload(callback: () => void): void {
		try {
			callback();
		} catch {
			callback();
		}
	}

	/**
     *  Calculates the mean of an array
     */
	private calcMean(arr: number[]): number {
		const sum = arr.reduce((partialSum, x) => partialSum + x, 0);
		return sum / arr.length;
	}

	/**
     * Calculates the standard deviation of an array
     */
	private calcStd(arr: number[]): number {
		const mean = this.calcMean(arr);

		// get squared diff from mean
		const sqDiffs = arr.map(value => {
			const diff = value - mean;
			return diff * diff;
		});

		const avgSqDiff = this.calcMean(sqDiffs);

		return Math.sqrt(avgSqDiff);
	}

	/**
     * Get memory and cpu statistics
     */
	private async monitorStats(): Promise<void> {
		while (this.monitoringActive) {
			const stats = await pidusage(process.pid);

			if (this.activeTest !== 'none') {
				this.cpuStats[this.activeTest].push(stats.cpu);
				this.memStats[this.activeTest].push(stats.memory);
			}

			await this.wait(100);
		}
	}

	/**
     *    Time to wait in ms
     */
	private async wait(ms: number): Promise<void> {
		return new Promise(resolve => {
			setTimeout(() => {
				resolve();
			}, ms);
		});
	}

	/**
	 * Measure the Node.js event loop lag and repeatedly call the provided callback function with the updated results
	 * @param {number} ms The number of milliseconds for monitoring
	 * @param {function} cb Callback function to call for each new value
	 */
	private measureEventLoopLag(ms:number, cb: (lag: number) => void): void {
		let start = hrtime();

		let timeout: Timeout;

		const check = () => {
			// how much time has actually elapsed in the loop beyond what
			// setTimeout says is supposed to happen. we use setTimeout to
			// cover multiple iterations of the event loop, getting a larger
			// sample of what the process is working on.
			const t = hrtime();

			// we use Math.max to handle case where timers are running efficiently
			// and our callback executes earlier than `ms` due to how timers are
			// implemented. this is ok. it means we're healthy.
			cb && cb(Math.max(0, t - start - ms));
			start = t;

			// stop the process if no test active
			if (this.monitoringActive) {
				timeout = setTimeout(check, ms);
				timeout.unref();
			}
		};

		timeout = setTimeout(check, ms);
		timeout.unref();

		function hrtime():number {
			const t = process.hrtime();
			return (t[0] * 1e3) + (t[1] / 1e6);
		}
	}

	/**
	 * Round at two decimal places
	 * @private
	 */
	private round(number: number): number {
		return (Math.round(number * 100) / 100);
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Benchmark(options);
} else {
	// otherwise start the instance directly
	(() => new Benchmark())();
}
