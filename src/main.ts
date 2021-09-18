import * as utils from '@iobroker/adapter-core';
import pidusage from 'pidusage';
import {testObjects} from './lib/helper';
import {tests as allTests} from './lib/allTests';

class Benchmark extends utils.Adapter {
	private activeTest: string;
	private readonly memStats: any;
	private readonly cpuStats: any;
	private readonly restartInstances: string[];

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: 'benchmark'
		});
		this.on('ready', this.onReady.bind(this));
		// this.on('objectChange', this.onObjectChange.bind(this));
		this.on('message', this.onMessage.bind(this));

		this.on('unload', this.onUnload.bind(this));
		this.activeTest = 'none';

		this.memStats = {};
		this.cpuStats = {};
		this.restartInstances = [];
	}

	/**
     * Is called when databases are connected and adapter received configuration.
     */
	private async onReady(): Promise<void> {
		if (!this.config.secondaryMode) {
			if (this.config.isolatedRun) {
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
			this.runActiveTests();
		}
	}

	/**
     * Execute the tests for a non secondary adapter
     * @private
     */
	private async runActiveTests(): Promise<void> {
		this.config.iterations = this.config.iterations || 10000;
		this.config.epochs = this.config.epochs || 5;

		const times: Record<string, any> = {};

		// monitor stats up from the beginning
		this.monitorStats();
		this.log.info('Starting benchmark test...');

		for (const activeTestName of Object.keys(allTests)) {
			times[activeTestName] = [];
			this.cpuStats[activeTestName] = [];
			this.memStats[activeTestName] = [];

			// create objects for this test
			for (const obj of testObjects) {
				const origId = obj._id;
				obj._id = `${this.namespace}.${activeTestName}.${obj._id}`;
				await this.setForeignObjectNotExistsAsync(obj._id, obj);
				// reset id
				obj._id = origId;
			}

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
			}

			// set states - TIME
			await this.setStateAsync(`${activeTestName}.timeMean`, this.calcMean(times[activeTestName]), true);
			await this.setStateAsync(`${activeTestName}.timeStd`, this.calcStd(times[activeTestName]), true);

			// set states - CPU
			await this.setStateAsync(`${activeTestName}.cpuMean`, this.calcMean(this.cpuStats[activeTestName]), true);
			await this.setStateAsync(`${activeTestName}.cpuStd`, this.calcStd(this.cpuStats[activeTestName]), true);

			// set states - MEM
			await this.setStateAsync(`${activeTestName}.memMean`, this.calcMean(this.memStats[activeTestName]), true);
			await this.setStateAsync(`${activeTestName}.memStd`, this.calcStd(this.memStats[activeTestName]), true);
		}

		if (this.config.isolatedRun) {
			this.log.info('Restarting instances ...');
			for (const id of this.restartInstances) {
				const obj = await this.getForeignObjectAsync(id);
				if (obj && obj.common) {
					obj.common.enabled = true;
					await this.setForeignObjectAsync(id, obj);
				}
			}
		}

		this.log.info('Finished benchmark... terminating');
		this.terminate();
	}

	/**
     * As secondary we want to listen to messages for tests
     */
	private async onMessage(obj: ioBroker.Message): Promise<void> {
		// only secondary mode instances need to response to messages
		if (!this.config.secondaryMode) {
			return;
		}

		switch (obj.command) {
			case 'objects':
				if (typeof obj.message === 'object' && obj.message.cmd === 'set' && typeof obj.message.n === 'number') {
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
				}
				break;
			case 'states':
				if (typeof obj.message === 'object' && obj.message.cmd === 'set' && typeof obj.message.n === 'number') {
					// set states
					for (let i = 0; i < obj.message.n; i++) {
						await this.setStateAsync(`test.${i}`, i, true);
					}
				}
				break;
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
     * Is called if a subscribed state changes
     */
	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
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
		while (true) {
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
}

if (require.main !== module) {
	// Export the constructor in compact mode
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Benchmark(options);
} else {
	// otherwise start the instance directly
	(() => new Benchmark())();
}
