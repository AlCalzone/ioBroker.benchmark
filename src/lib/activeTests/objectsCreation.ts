import {AdapterInstance} from '@iobroker/adapter-core';
import {TestUtils} from '../testClass';

export class Test extends TestUtils {

	public constructor(adapter: AdapterInstance) {
		super(adapter);
	}

	/**
     * Everything to setup the test but does not need to be measured
     */
	public async prepare(): Promise<void> {
		// nothing needed
	}

	/**
     * The test itself
     */
	public async execute(): Promise<void> {
		// set objects
		await this.addObjects(this.adapter.config.iterations, 0);
	}

	/**
     * Clean up the db, remove insatnces, etc.
     */
	public async cleanUp(): Promise<void> {
		// delete objects
		await this.delObjects(this.adapter.config.iterations, 0);
	}
}
