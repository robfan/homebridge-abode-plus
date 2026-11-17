import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	API,
	Characteristic,
	DynamicPlatformPlugin,
	Logging,
	PlatformAccessory,
	PlatformConfig,
	Service,
} from "homebridge";

import { AbodeClient, describeError } from "./abode/client";
import { AbodeSocket } from "./abode/events";
import { AbodeDevice, AbodeDeviceType } from "./abode/types";
import { AbodeAccessory, AccessoryContext } from "./accessories/base";
import { GarageDoorAccessory } from "./accessories/garageDoor";
import { BulbAccessory, DimmerAccessory, SwitchAccessory, SwitchServiceType } from "./accessories/lights";
import { LockAccessory } from "./accessories/lock";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";

interface AbodeConfig extends PlatformConfig {
	email?: string;
	password?: string;
	mfaSecret?: string;
	garageDoors?: boolean;
	locks?: boolean;
	lights?: boolean;
	switchType?: SwitchServiceType;
	exclude?: string[];
	pollingInterval?: number;
}

type DeviceCategory = "garageDoors" | "locks" | "lights";

const CATEGORY_BY_TYPE: Record<string, DeviceCategory> = {
	[AbodeDeviceType.GarageDoor]: "garageDoors",
	[AbodeDeviceType.Lock]: "locks",
	[AbodeDeviceType.Switch]: "lights",
	[AbodeDeviceType.Dimmer]: "lights",
	[AbodeDeviceType.LightBulb]: "lights",
	[AbodeDeviceType.Hue]: "lights",
};

const DEFAULT_POLLING_MINUTES = 5;
const OFFLINE_GRACE_MS = 30000;
const LOCAL_CHANGE_SETTLE_MS = 2000;

export class AbodePlatform implements DynamicPlatformPlugin {
	readonly Service: typeof Service;
	readonly Characteristic: typeof Characteristic;

	client!: AbodeClient;
	online = false;

	private readonly cached = new Map<string, PlatformAccessory<AccessoryContext>>();
	private readonly handlers = new Map<string, AbodeAccessory>();
	private readonly localChanges = new Map<string, number>();
	private readonly pendingRefresh = new Map<string, NodeJS.Timeout>();
	private socket?: AbodeSocket;
	private offlineTimer?: NodeJS.Timeout;
	private pollTimer?: NodeJS.Timeout;

	constructor(
		readonly log: Logging,
		readonly config: AbodeConfig,
		readonly api: API,
	) {
		this.Service = api.hap.Service;
		this.Characteristic = api.hap.Characteristic;

		api.on("didFinishLaunching", () => void this.start());
		api.on("shutdown", () => this.stop());
	}

	configureAccessory(accessory: PlatformAccessory) {
		this.log.debug("Loaded cached accessory:", accessory.displayName);
		this.cached.set(accessory.UUID, accessory as PlatformAccessory<AccessoryContext>);
	}

	private async start() {
		const { email, password } = this.config;
		if (!email || !password) {
			this.log.error('Missing "email" or "password" in the plugin config.');
			return;
		}

		this.client = new AbodeClient({
			email,
			password,
			mfaSecret: this.config.mfaSecret?.trim() || undefined,
			deviceUuid: this.loadDeviceUuid(),
			userAgent: `Homebridge/${this.api.serverVersion}`,
			log: this.log,
		});

		try {
			await this.client.start();
		} catch (error) {
			this.log.error(describeError(error));
			this.log.error("Abode accessories will not respond until the plugin can sign in. Fix the config and restart.");
			return;
		}

		await this.refreshAll(true);

		this.socket = new AbodeSocket(this.client, this.log);
		this.socket.on("connected", () => {
			if (this.offlineTimer) clearTimeout(this.offlineTimer);
			this.offlineTimer = undefined;
			void this.refreshAll(false);
		});
		this.socket.on("disconnected", () => {
			if (this.offlineTimer) return;
			this.offlineTimer = setTimeout(() => {
				this.log.warn("Lost connection to Abode; device states may be stale until it reconnects.");
				for (const handler of this.handlers.values()) handler.markUnknown();
			}, OFFLINE_GRACE_MS);
		});
		this.socket.on("deviceUpdated", (id) => this.handleDeviceUpdated(id));
		this.socket.open();

		const minutes = this.config.pollingInterval ?? DEFAULT_POLLING_MINUTES;
		if (minutes > 0) {
			this.pollTimer = setInterval(() => void this.refreshAll(false), Math.max(1, minutes) * 60 * 1000);
		}
	}

	private stop() {
		this.socket?.close();
		this.client?.stop();
		if (this.pollTimer) clearInterval(this.pollTimer);
		if (this.offlineTimer) clearTimeout(this.offlineTimer);
	}

	/** A persistent per-install id; Abode ties "remember this device" to it. */
	private loadDeviceUuid(): string {
		const file = join(this.api.user.storagePath(), ".homebridge-abode.json");
		try {
			const stored = JSON.parse(readFileSync(file, "utf8"));
			if (typeof stored.deviceUuid === "string" && stored.deviceUuid) return stored.deviceUuid;
		} catch {
			// first run
		}
		const deviceUuid = randomUUID();
		try {
			writeFileSync(file, JSON.stringify({ deviceUuid }, null, 2));
		} catch (error) {
			this.log.warn("Could not save Abode device id:", describeError(error));
		}
		return deviceUuid;
	}

	private isWanted(device: AbodeDevice): boolean {
		const category = CATEGORY_BY_TYPE[device.type_tag];
		if (!category) return false;
		if (this.config[category] === false) return false;
		const excluded = (this.config.exclude ?? []).map((e) => e.trim().toLowerCase());
		return !excluded.includes(device.id.toLowerCase()) && !excluded.includes(device.name.toLowerCase());
	}

	/** Fetch every device; add new ones, update existing ones and (on a full sync) remove ones that are gone. */
	private async refreshAll(initial: boolean) {
		let devices: AbodeDevice[];
		try {
			devices = await this.client.getDevices();
			this.online = true;
		} catch (error) {
			this.log.error("Failed to fetch Abode devices:", describeError(error));
			this.online = false;
			return;
		}

		if (initial) {
			const types = [...new Set(devices.map((d) => d.type_tag))].join(", ");
			this.log.debug(`Abode returned ${devices.length} devices (${types})`);
		}

		const seen = new Set<string>();
		for (const device of devices) {
			if (!this.isWanted(device)) continue;
			const uuid = this.api.hap.uuid.generate(device.id);
			seen.add(uuid);
			this.upsert(uuid, device)?.update(device);
		}

		// Only prune on a non-empty response so an Abode hiccup can't wipe every accessory.
		if (devices.length > 0) {
			const stale = [...this.cached.values()].filter((a) => !seen.has(a.UUID));
			for (const accessory of stale) {
				this.log.info("Removing accessory no longer in Abode (or excluded):", accessory.displayName);
				this.cached.delete(accessory.UUID);
				this.handlers.delete(accessory.context.device?.id);
			}
			if (stale.length) this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
		}
	}

	private upsert(uuid: string, device: AbodeDevice): AbodeAccessory | undefined {
		const existing = this.handlers.get(device.id);
		if (existing) return existing;

		let accessory = this.cached.get(uuid);
		const isNew = !accessory;
		if (!accessory) {
			this.log.info(`Adding ${device.name} (${device.type_tag})`);
			accessory = new this.api.platformAccessory<AccessoryContext>(device.name, uuid);
		} else {
			this.log.debug("Restoring cached accessory:", accessory.displayName);
		}
		accessory.context.device = { id: device.id, uuid: device.uuid, name: device.name, type_tag: device.type_tag };

		const handler = this.createHandler(accessory, device.type_tag);
		if (!handler) return undefined;
		this.handlers.set(device.id, handler);

		if (isNew) {
			this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
			this.cached.set(uuid, accessory);
		} else {
			this.api.updatePlatformAccessories([accessory]);
		}
		return handler;
	}

	private createHandler(accessory: PlatformAccessory<AccessoryContext>, type: string): AbodeAccessory | undefined {
		switch (type) {
			case AbodeDeviceType.GarageDoor:
				return new GarageDoorAccessory(this, accessory);
			case AbodeDeviceType.Lock:
				return new LockAccessory(this, accessory);
			case AbodeDeviceType.Switch:
				return new SwitchAccessory(this, accessory, this.config.switchType ?? "switch");
			case AbodeDeviceType.Dimmer:
				return new DimmerAccessory(this, accessory);
			case AbodeDeviceType.LightBulb:
			case AbodeDeviceType.Hue:
				return new BulbAccessory(this, accessory);
			default:
				return undefined;
		}
	}

	/** Called by accessories right before they send a command. */
	markLocalChange(deviceId: string) {
		this.localChanges.set(deviceId, Date.now());
	}

	private handleDeviceUpdated(deviceId: string) {
		const handler = this.handlers.get(deviceId);
		if (!handler) {
			// Could be a newly added device or one we don't support; a full refresh sorts it out.
			this.scheduleRefresh("__all__", 1000, () => this.refreshAll(false));
			return;
		}

		// Right after we change a device Abode can echo an intermediate state; wait for it to settle.
		const sinceLocal = Date.now() - (this.localChanges.get(deviceId) ?? 0);
		const delay = sinceLocal < LOCAL_CHANGE_SETTLE_MS ? LOCAL_CHANGE_SETTLE_MS - sinceLocal : 250;

		this.scheduleRefresh(deviceId, delay, async () => {
			try {
				const device = await this.client.getDevice(deviceId);
				if (device) handler.update(device);
				this.online = true;
			} catch (error) {
				this.log.debug(`Failed to refresh ${handler.name}:`, describeError(error));
			}
		});
	}

	private scheduleRefresh(key: string, delay: number, fn: () => Promise<void>) {
		const pending = this.pendingRefresh.get(key);
		if (pending) clearTimeout(pending);
		this.pendingRefresh.set(
			key,
			setTimeout(() => {
				this.pendingRefresh.delete(key);
				void fn();
			}, delay),
		);
	}
}
