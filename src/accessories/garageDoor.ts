import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";

import { AbodeDevice } from "../abode/types";
import type { AbodePlatform } from "../platform";
import { AbodeAccessory, AccessoryContext, isFaulted } from "./base";

export class GarageDoorAccessory extends AbodeAccessory {
	private readonly service: Service;
	private current: number;
	private target: number;

	constructor(platform: AbodePlatform, accessory: PlatformAccessory<AccessoryContext>) {
		super(platform, accessory, "Garage Door");
		const C = platform.Characteristic;

		this.current = C.CurrentDoorState.CLOSED;
		this.target = C.TargetDoorState.CLOSED;

		this.service =
			accessory.getService(platform.Service.GarageDoorOpener) ||
			accessory.addService(platform.Service.GarageDoorOpener);
		this.service.setCharacteristic(C.Name, this.name);

		this.service.getCharacteristic(C.CurrentDoorState).onGet(this.get(() => this.current));
		this.service.getCharacteristic(C.ObstructionDetected).onGet(this.get(() => false));
		this.service
			.getCharacteristic(C.TargetDoorState)
			.onGet(this.get(() => this.target))
			.onSet(this.set("TargetDoorState", (v) => this.setTarget(v)));
	}

	private async setTarget(value: CharacteristicValue) {
		const C = this.platform.Characteristic;
		const open = value === C.TargetDoorState.OPEN;
		await this.platform.client.controlGarageDoor(this.id, open ? 0 : 1);
		this.target = open ? C.TargetDoorState.OPEN : C.TargetDoorState.CLOSED;
		// Show opening/closing until Abode reports the final state.
		this.current = open ? C.CurrentDoorState.OPENING : C.CurrentDoorState.CLOSING;
		this.service.updateCharacteristic(C.CurrentDoorState, this.current);
	}

	update(device: AbodeDevice) {
		const C = this.platform.Characteristic;
		if (isFaulted(device.faults?.jammed)) {
			this.current = C.CurrentDoorState.STOPPED;
		} else if (device.status === "Closed") {
			this.current = C.CurrentDoorState.CLOSED;
			this.target = C.TargetDoorState.CLOSED;
		} else {
			this.current = C.CurrentDoorState.OPEN;
			this.target = C.TargetDoorState.OPEN;
		}
		this.service.updateCharacteristic(C.TargetDoorState, this.target);
		this.service.updateCharacteristic(C.CurrentDoorState, this.current);
	}

	markUnknown() {
		this.service.updateCharacteristic(
			this.platform.Characteristic.CurrentDoorState,
			this.platform.Characteristic.CurrentDoorState.STOPPED,
		);
	}
}
