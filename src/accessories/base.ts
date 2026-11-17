import { CharacteristicValue, PlatformAccessory } from "homebridge";

import { describeError } from "../abode/client";
import { AbodeDevice } from "../abode/types";
import type { AbodePlatform } from "../platform";

export interface AccessoryContext {
	device: { id: string; uuid?: string; name: string; type_tag: string };
}

export abstract class AbodeAccessory {
	constructor(
		protected readonly platform: AbodePlatform,
		readonly accessory: PlatformAccessory<AccessoryContext>,
		model: string,
	) {
		const { Service, Characteristic } = platform;
		const device = accessory.context.device;
		accessory
			.getService(Service.AccessoryInformation)!
			.setCharacteristic(Characteristic.Manufacturer, "abode")
			.setCharacteristic(Characteristic.Model, model)
			.setCharacteristic(Characteristic.SerialNumber, device.id)
			.setCharacteristic(Characteristic.AppMatchingIdentifier, "com.abode.abode");
	}

	get id(): string {
		return this.accessory.context.device.id;
	}

	get name(): string {
		return this.accessory.context.device.name;
	}

	/** Apply the latest state reported by Abode. */
	abstract update(device: AbodeDevice): void;

	/** Called when Abode is unreachable for a while. */
	abstract markUnknown(): void;

	/** Throw a HomeKit "no response" error when Abode is offline, otherwise return the cached value. */
	protected get<T extends CharacteristicValue>(value: () => T): () => T {
		return () => {
			if (!this.platform.online) {
				throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
			}
			return value();
		};
	}

	/** Wrap a setter so failures are logged and reported to HomeKit. */
	protected set(label: string, fn: (value: CharacteristicValue) => Promise<void>) {
		return async (value: CharacteristicValue) => {
			this.platform.log.debug(`${this.name}: set ${label} -> ${value}`);
			try {
				this.platform.markLocalChange(this.id);
				await fn(value);
			} catch (error) {
				this.platform.log.error(`${this.name}: failed to set ${label}:`, describeError(error));
				throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
			}
		};
	}
}

/** Abode reports power as "On"/"Off", "1"/"0" or 1/0 depending on device and field. */
export const isOn = (device: AbodeDevice): boolean => {
	const value = device.statuses?.switch ?? device.status;
	return value === 1 || value === "1" || (typeof value === "string" && value.toLowerCase() === "on");
};

export const isFaulted = (value: unknown): boolean => value === 1 || value === "1";

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Abode reports numeric statuses as strings and sometimes as "N/A". */
export const toNumber = (value: unknown, fallback: number): number => {
	const n = Number(value);
	return value === null || value === undefined || value === "" || !Number.isFinite(n) ? fallback : n;
};
