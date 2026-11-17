import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";

import { AbodeDevice } from "../abode/types";
import type { AbodePlatform } from "../platform";
import { AbodeAccessory, AccessoryContext, clamp, isOn, toNumber } from "./base";

export type SwitchServiceType = "switch" | "lightbulb" | "outlet";

/** Replace any previously used power service type with the requested one (e.g. after a config change). */
const ensureService = (
	platform: AbodePlatform,
	accessory: PlatformAccessory,
	wanted: typeof Service.Switch,
): Service => {
	const { Switch, Lightbulb, Outlet } = platform.Service;
	for (const type of [Switch, Lightbulb, Outlet]) {
		if (type.UUID === wanted.UUID) continue;
		const stale = accessory.getService(type);
		if (stale) accessory.removeService(stale);
	}
	return accessory.getService(wanted) || accessory.addService(wanted);
};

/** On/off power switches (device_type.power_switch_sensor). */
export class SwitchAccessory extends AbodeAccessory {
	private readonly service: Service;
	private on = false;

	constructor(platform: AbodePlatform, accessory: PlatformAccessory<AccessoryContext>, serviceType: SwitchServiceType) {
		super(platform, accessory, "Power Switch");
		const C = platform.Characteristic;
		const type =
			serviceType === "lightbulb"
				? platform.Service.Lightbulb
				: serviceType === "outlet"
					? platform.Service.Outlet
					: platform.Service.Switch;

		this.service = ensureService(platform, accessory, type);
		this.service.setCharacteristic(C.Name, this.name);
		this.service
			.getCharacteristic(C.On)
			.onGet(this.get(() => this.on))
			.onSet(
				this.set("On", async (value) => {
					await platform.client.controlSwitch(this.id, value ? 1 : 0);
					this.on = Boolean(value);
				}),
			);
	}

	update(device: AbodeDevice) {
		this.on = isOn(device);
		this.service.updateCharacteristic(this.platform.Characteristic.On, this.on);
	}

	markUnknown() {}
}

/** Z-Wave dimmers (device_type.dimmer_meter). */
export class DimmerAccessory extends AbodeAccessory {
	private readonly service: Service;
	private on = false;
	private brightness = 100;

	constructor(platform: AbodePlatform, accessory: PlatformAccessory<AccessoryContext>) {
		super(platform, accessory, "Dimmer");
		const C = platform.Characteristic;

		this.service = ensureService(platform, accessory, platform.Service.Lightbulb);
		this.service.setCharacteristic(C.Name, this.name);

		this.service
			.getCharacteristic(C.On)
			.onGet(this.get(() => this.on))
			.onSet(this.set("On", (v) => this.setOn(v)));
		this.service
			.getCharacteristic(C.Brightness)
			.onGet(this.get(() => this.brightness))
			.onSet(this.set("Brightness", (v) => this.setBrightness(v)));
	}

	private async setOn(value: CharacteristicValue) {
		// HomeKit sends On=true alongside a brightness change; skip the redundant call.
		if (Boolean(value) === this.on) return;
		await this.platform.client.controlDimmer(this.id, { status: value ? 1 : 0 });
		this.on = Boolean(value);
	}

	private async setBrightness(value: CharacteristicValue) {
		const level = clamp(Math.round(Number(value)), 0, 100);
		await this.platform.client.controlDimmer(this.id, { level });
		this.brightness = level;
		this.on = level > 0;
	}

	update(device: AbodeDevice) {
		const C = this.platform.Characteristic;
		this.on = isOn(device);
		const level = toNumber(device.statuses?.level, -1);
		if (level > 0) this.brightness = clamp(level, 0, 100);
		this.service.updateCharacteristic(C.On, this.on);
		this.service.updateCharacteristic(C.Brightness, this.brightness);
	}

	markUnknown() {}
}

const MIN_MIRED = 154; // ~6500K
const MAX_MIRED = 500; // 2000K
const kelvinToMired = (k: number) => Math.round(1_000_000 / k);

/** Abode smart bulbs and Philips Hue lights linked to Abode (device_type.light_bulb / device_type.hue). */
export class BulbAccessory extends AbodeAccessory {
	private readonly service: Service;
	private on = false;
	private brightness = 100;
	private hue = 0;
	private saturation = 0;
	private mired = 370;
	private colorTimer?: NodeJS.Timeout;

	constructor(platform: AbodePlatform, accessory: PlatformAccessory<AccessoryContext>) {
		super(platform, accessory, "Light Bulb");
		const C = platform.Characteristic;

		this.service = ensureService(platform, accessory, platform.Service.Lightbulb);
		this.service.setCharacteristic(C.Name, this.name);

		this.service
			.getCharacteristic(C.On)
			.onGet(this.get(() => this.on))
			.onSet(
				this.set("On", async (value) => {
					if (Boolean(value) === this.on) return;
					await this.send({ action: value ? "on" : "off" });
					this.on = Boolean(value);
				}),
			);
		this.service
			.getCharacteristic(C.Brightness)
			.onGet(this.get(() => this.brightness))
			.onSet(
				this.set("Brightness", async (value) => {
					const percentage = clamp(Math.round(Number(value)), 0, 100);
					await this.send({ action: "setpercent", percentage });
					this.brightness = percentage;
				}),
			);
		// HomeKit sends hue and saturation as two separate writes; combine them into one request.
		this.service
			.getCharacteristic(C.Hue)
			.onGet(this.get(() => this.hue))
			.onSet((value) => {
				this.hue = Number(value);
				this.queueColor();
			});
		this.service
			.getCharacteristic(C.Saturation)
			.onGet(this.get(() => this.saturation))
			.onSet((value) => {
				this.saturation = Number(value);
				this.queueColor();
			});
		this.service
			.getCharacteristic(C.ColorTemperature)
			.updateValue(this.mired)
			.setProps({ minValue: MIN_MIRED, maxValue: MAX_MIRED })
			.onGet(this.get(() => this.mired))
			.onSet(
				this.set("ColorTemperature", async (value) => {
					const mired = clamp(Number(value), MIN_MIRED, MAX_MIRED);
					await this.send({ action: "setcolortemperature", colorTemperature: Math.round(1_000_000 / mired) });
					this.mired = mired;
				}),
			);
	}

	private get uuid(): string {
		return this.accessory.context.device.uuid || this.id;
	}

	private async send(data: Record<string, unknown>) {
		await this.platform.client.controlBulb(this.uuid, data);
	}

	private queueColor() {
		if (this.colorTimer) clearTimeout(this.colorTimer);
		this.colorTimer = setTimeout(() => {
			this.platform.markLocalChange(this.id);
			this.send({ action: "setcolor", hue: Math.round(this.hue), saturation: Math.round(this.saturation) }).catch(
				(error) => this.platform.log.error(`${this.name}: failed to set color:`, error?.message ?? error),
			);
		}, 100);
	}

	update(device: AbodeDevice) {
		const C = this.platform.Characteristic;
		const s = device.statuses ?? {};
		this.on = isOn(device);
		this.brightness = clamp(toNumber(s.level, this.brightness), 0, 100);
		this.hue = clamp(toNumber(s.hue, this.hue), 0, 360);
		this.saturation = clamp(toNumber(s.saturation, this.saturation), 0, 100);
		const kelvin = toNumber(s.color_temp, 0);
		if (kelvin > 0) this.mired = clamp(kelvinToMired(kelvin), MIN_MIRED, MAX_MIRED);

		this.service.updateCharacteristic(C.On, this.on);
		this.service.updateCharacteristic(C.Brightness, this.brightness);
		this.service.updateCharacteristic(C.Hue, this.hue);
		this.service.updateCharacteristic(C.Saturation, this.saturation);
		this.service.updateCharacteristic(C.ColorTemperature, this.mired);
	}

	markUnknown() {}
}
