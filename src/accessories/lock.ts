import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";

import { AbodeDevice } from "../abode/types";
import type { AbodePlatform } from "../platform";
import { AbodeAccessory, AccessoryContext, isFaulted } from "./base";

export class LockAccessory extends AbodeAccessory {
	private readonly service: Service;
	private current: number;
	private target: number;
	private lowBattery = false;

	constructor(platform: AbodePlatform, accessory: PlatformAccessory<AccessoryContext>) {
		super(platform, accessory, "Door Lock");
		const C = platform.Characteristic;

		this.current = C.LockCurrentState.UNKNOWN;
		this.target = C.LockTargetState.SECURED;

		this.service =
			accessory.getService(platform.Service.LockMechanism) || accessory.addService(platform.Service.LockMechanism);
		this.service.setCharacteristic(C.Name, this.name);

		this.service.getCharacteristic(C.LockCurrentState).onGet(this.get(() => this.current));
		this.service
			.getCharacteristic(C.LockTargetState)
			.onGet(this.get(() => this.target))
			.onSet(this.set("LockTargetState", (v) => this.setTarget(v)));
	}

	private async setTarget(value: CharacteristicValue) {
		const C = this.platform.Characteristic;
		const lock = value === C.LockTargetState.SECURED;
		await this.platform.client.controlLock(this.id, lock ? 1 : 0);
		this.target = lock ? C.LockTargetState.SECURED : C.LockTargetState.UNSECURED;
	}

	update(device: AbodeDevice) {
		const C = this.platform.Characteristic;
		if (isFaulted(device.faults?.jammed)) {
			this.current = C.LockCurrentState.JAMMED;
		} else if (device.status === "LockClosed") {
			this.current = C.LockCurrentState.SECURED;
			this.target = C.LockTargetState.SECURED;
		} else if (device.status === "LockOpen") {
			this.current = C.LockCurrentState.UNSECURED;
			this.target = C.LockTargetState.UNSECURED;
		} else {
			this.current = C.LockCurrentState.UNKNOWN;
		}
		this.service.updateCharacteristic(C.LockTargetState, this.target);
		this.service.updateCharacteristic(C.LockCurrentState, this.current);

		const lowBattery = isFaulted(device.faults?.low_battery);
		if (lowBattery !== this.lowBattery) {
			this.lowBattery = lowBattery;
			this.platform.log.warn(`${this.name}: battery ${lowBattery ? "is low" : "OK"}`);
		}
		const battery =
			this.accessory.getService(this.platform.Service.Battery) ||
			this.accessory.addService(this.platform.Service.Battery);
		battery.updateCharacteristic(
			C.StatusLowBattery,
			lowBattery ? C.StatusLowBattery.BATTERY_LEVEL_LOW : C.StatusLowBattery.BATTERY_LEVEL_NORMAL,
		);
	}

	markUnknown() {
		this.service.updateCharacteristic(
			this.platform.Characteristic.LockCurrentState,
			this.platform.Characteristic.LockCurrentState.UNKNOWN,
		);
	}
}
