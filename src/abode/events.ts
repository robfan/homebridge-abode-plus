import { EventEmitter } from "node:events";
import { Logging } from "homebridge";
import WebSocket from "ws";

import { AbodeClient, ORIGIN, describeError } from "./client";
import { AbodeEventType } from "./types";

const WS_URL = "wss://my.goabode.com/socket.io/?EIO=3&transport=websocket";
const PING_INTERVAL_MS = 25000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;

export interface AbodeSocketEvents {
	connected: [];
	disconnected: [];
	deviceUpdated: [deviceId: string];
}

/**
 * Listens to Abode's socket.io feed (engine.io v3 over a raw websocket) for device change events.
 */
export class AbodeSocket extends EventEmitter<AbodeSocketEvents> {
	private ws?: WebSocket;
	private pingTimer?: NodeJS.Timeout;
	private reconnectTimer?: NodeJS.Timeout;
	private reconnectWait = RECONNECT_MIN_MS;
	private stopped = false;

	constructor(
		private readonly client: AbodeClient,
		private readonly log: Logging,
	) {
		super();
	}

	open(): void {
		if (this.ws || this.stopped) return;

		const ws = new WebSocket(WS_URL, {
			headers: { Cookie: this.client.cookie, Origin: ORIGIN, "User-Agent": this.client.userAgent },
		});
		this.ws = ws;

		ws.on("open", () => {
			this.log.debug("Abode socket open");
			this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("2"), PING_INTERVAL_MS);
			this.emit("connected");
		});

		ws.on("message", (data) => this.handleMessage(data.toString()));

		ws.on("error", (error) => this.log.debug("Abode socket error:", error.message));

		ws.on("close", () => {
			if (this.pingTimer) clearInterval(this.pingTimer);
			this.ws = undefined;
			this.emit("disconnected");
			this.scheduleReconnect();
		});
	}

	close(): void {
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.ws?.close();
	}

	private handleMessage(message: string): void {
		if (message.includes(`"Not Authorized"`)) {
			this.log.debug("Abode socket not authorized, reconnecting");
			this.ws?.close();
			return;
		}

		// Any real traffic after the handshake means the connection is healthy again.
		if (!message.startsWith("0{")) this.reconnectWait = RECONNECT_MIN_MS;

		// engine.io packet type "4" + socket.io packet type "2" = event; strip the numeric prefix.
		const json = message.replace(/^[:\d]*/, "");
		if (!json) return;

		try {
			const event = JSON.parse(json);
			if (Array.isArray(event) && event[0] === AbodeEventType.DeviceUpdate && typeof event[1] === "string") {
				this.emit("deviceUpdated", event[1]);
			}
		} catch (error) {
			this.log.debug("Failed to parse Abode socket message:", describeError(error));
		}
	}

	private scheduleReconnect(): void {
		if (this.stopped) return;
		const wait = this.reconnectWait;
		this.reconnectWait = Math.min(this.reconnectWait * 2, RECONNECT_MAX_MS);
		this.log.debug(`Reconnecting Abode socket in ${wait / 1000}s`);
		this.reconnectTimer = setTimeout(async () => {
			await this.client.renewSession();
			this.open();
		}, wait);
	}
}
