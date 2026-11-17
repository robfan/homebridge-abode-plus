export const enum AbodeDeviceType {
	GarageDoor = "device_type.secure_barrier",
	Lock = "device_type.door_lock",
	Switch = "device_type.power_switch_sensor",
	Dimmer = "device_type.dimmer_meter",
	LightBulb = "device_type.light_bulb",
	Hue = "device_type.hue",
}

export interface AbodeFaults {
	readonly low_battery?: number | string;
	readonly jammed?: number | string;
	readonly [key: string]: unknown;
}

export interface AbodeDevice {
	readonly id: string;
	readonly uuid?: string;
	readonly type_tag: string;
	readonly type?: string;
	readonly name: string;
	readonly version?: string;
	readonly status?: string;
	readonly statuses?: Record<string, unknown>;
	readonly faults?: AbodeFaults;
}

export const enum AbodeEventType {
	DeviceUpdate = "com.goabode.device.update",
}

/** Error code Abode returns when the gateway is briefly unreachable. */
export const ABODE_GATEWAY_UNREACHABLE = 2191;
