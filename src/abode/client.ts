import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from "axios";
import { Logging } from "homebridge";

import { generateTotp, totpSecondsRemaining } from "./totp";
import { ABODE_GATEWAY_UNREACHABLE, AbodeDevice } from "./types";

export const API_BASE_URL = "https://my.goabode.com";
export const ORIGIN = "https://my.goabode.com/";

/** How often the session and OAuth token are refreshed (25 minutes, same as the Abode web app). */
const SESSION_RENEW_INTERVAL_MS = 25 * 60 * 1000;

export interface AbodeClientOptions {
	readonly email: string;
	readonly password: string;
	/** Base32 setup key from Abode's authenticator-app 2FA enrollment. */
	readonly mfaSecret?: string;
	/** Stable device identifier, persisted so Abode recognises this Homebridge instance across restarts. */
	readonly deviceUuid: string;
	readonly userAgent: string;
	readonly log: Logging;
}

export class AbodeAuthError extends Error {}

export class AbodeClient {
	private session = "";
	private apiKey = "";
	private oauthToken = "";
	private renewTimer?: NodeJS.Timeout;
	private authInFlight?: Promise<void>;

	readonly http: AxiosInstance;

	constructor(private readonly options: AbodeClientOptions) {
		this.http = axios.create({
			baseURL: API_BASE_URL,
			timeout: 15000,
			headers: { "User-Agent": options.userAgent },
		});

		this.http.interceptors.request.use((config) => this.attachAuth(config));
	}

	get userAgent(): string {
		return this.options.userAgent;
	}

	get cookie(): string {
		return `SESSION=${this.session};uuid=${this.options.deviceUuid}`;
	}

	get isAuthenticated(): boolean {
		return Boolean(this.session && this.apiKey && this.oauthToken);
	}

	/** Sign in and keep the session alive. */
	async start(): Promise<void> {
		await this.login();
		this.renewTimer = setInterval(() => void this.renewSession(), SESSION_RENEW_INTERVAL_MS);
	}

	stop(): void {
		if (this.renewTimer) clearInterval(this.renewTimer);
	}

	private attachAuth(config: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
		const url = config.url ?? "";
		const isAuthPath = url.startsWith("/api/auth2/");
		const isSessionPath = url === "/api/v1/session";

		config.headers.set("Cookie", this.cookie);
		if (isAuthPath) return config;

		if (!this.session || !this.apiKey) {
			throw new AbodeAuthError("Not signed in to Abode.");
		}
		config.headers.set("ABODE-API-KEY", this.apiKey);
		if (isSessionPath) return config;

		if (!this.oauthToken) {
			throw new AbodeAuthError("Missing Abode OAuth token.");
		}
		config.headers.set("Authorization", `Bearer ${this.oauthToken}`);
		return config;
	}

	/** Full sign in. Concurrent callers share one attempt. */
	login(): Promise<void> {
		if (!this.authInFlight) {
			this.authInFlight = this.performLogin().finally(() => {
				this.authInFlight = undefined;
			});
		}
		return this.authInFlight;
	}

	private async performLogin(): Promise<void> {
		const { email, password, mfaSecret, deviceUuid, log } = this.options;
		this.session = "";
		this.apiKey = "";
		this.oauthToken = "";

		const body: Record<string, unknown> = { id: email, password, uuid: deviceUuid };

		if (mfaSecret) {
			// A code that is about to expire may be rejected by the time it reaches Abode; wait for the next one.
			const remaining = totpSecondsRemaining();
			if (remaining <= 2) {
				await new Promise((resolve) => setTimeout(resolve, (remaining + 1) * 1000));
			}
			body.mfa_code = generateTotp(mfaSecret);
			body.remember_me = 1;
		}

		log.info(mfaSecret ? "Signing in to Abode (with 2FA code)" : "Signing in to Abode");

		let response;
		try {
			response = await this.http.post("/api/auth2/login", body);
		} catch (error) {
			throw new AbodeAuthError(`Abode sign in failed: ${describeError(error)}`);
		}

		const data = response.data ?? {};
		if (data.mfa_type) {
			if (mfaSecret) {
				throw new AbodeAuthError(
					`Abode rejected the 2FA code (mfa_type "${data.mfa_type}"). Check that "2FA Secret" is the setup key for this account (not a 6-digit code) and that the Homebridge host's clock is correct.`,
				);
			}
			throw new AbodeAuthError(
				`This Abode account has two-factor authentication enabled (mfa_type "${data.mfa_type}"). Turn on "Use two-factor authentication" in the plugin settings and enter your 2FA secret (the setup key, not a 6-digit code).`,
			);
		}

		const apiKey = data.token;
		if (!apiKey) throw new AbodeAuthError("Abode sign in response did not contain an API key.");

		const session = parseSetCookie(response.headers["set-cookie"]).SESSION;
		if (!session) throw new AbodeAuthError("Abode sign in response did not contain a session cookie.");

		this.session = session;
		this.apiKey = apiKey;
		this.oauthToken = await this.fetchOAuthToken();
		log.info("Signed in to Abode");
	}

	private async fetchOAuthToken(): Promise<string> {
		const response = await this.http.get("/api/auth2/claims");
		const token = response.data?.access_token;
		if (!token) throw new AbodeAuthError("Abode claims response did not contain an OAuth token.");
		return token;
	}

	/** Refresh the session and token, falling back to a full sign in. */
	async renewSession(): Promise<void> {
		try {
			this.options.log.debug("Renewing Abode session");
			const response = await this.http.get("/api/v1/session");
			if (response.data?.id) this.session = response.data.id;
			this.oauthToken = await this.fetchOAuthToken();
		} catch (error) {
			this.options.log.debug("Session renewal failed, signing in again:", describeError(error));
			try {
				await this.login();
			} catch (loginError) {
				this.options.log.error(describeError(loginError));
			}
		}
	}

	/** Run a request, signing in again once if Abode says the session has expired. */
	private async request<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (error) {
			const status = (error as AxiosError).response?.status;
			if (error instanceof AbodeAuthError || status === 401 || status === 403) {
				await this.login();
				return fn();
			}
			throw error;
		}
	}

	async getDevices(): Promise<AbodeDevice[]> {
		const response = await this.request(() => this.http.get<AbodeDevice[]>("/api/v1/devices"));
		return Array.isArray(response.data) ? response.data : [];
	}

	async getDevice(id: string): Promise<AbodeDevice | undefined> {
		const response = await this.request(() =>
			this.http.get<AbodeDevice[] | AbodeDevice>(`/api/v1/devices/${id}`),
		);
		const data = response.data;
		return Array.isArray(data) ? data[0] : data;
	}

	/** Door locks: status 0 = unlock, 1 = lock. */
	controlLock(id: string, status: 0 | 1) {
		return this.control(`/api/v1/control/lock/${id}`, { status });
	}

	/** Garage doors (secure barriers): status 0 = open, 1 = close. */
	controlGarageDoor(id: string, status: 0 | 1) {
		return this.control(`/api/v1/control/power_switch/${id}`, { status });
	}

	/** Power switches: status 1 = on, 0 = off. */
	controlSwitch(id: string, status: 0 | 1) {
		return this.control(`/api/v1/control/power_switch/${id}`, { status });
	}

	/** Dimmers: either power ({ status }) or brightness ({ level: 0-100 }). */
	controlDimmer(id: string, data: { status?: 0 | 1; level?: number }) {
		return this.control(`/api/v1/control/light/${id}`, data);
	}

	/** Bulbs (Abode bulbs and Hue) are controlled through the integrations endpoint, keyed by device uuid. */
	async controlBulb(uuid: string, data: Record<string, unknown>) {
		await this.request(() => this.http.post(`/integrations/v1/devices/${uuid}`, data));
	}

	private async control(path: string, data: Record<string, unknown>) {
		try {
			const response = await this.request(() => this.http.put(path, data));
			return response.data;
		} catch (error) {
			const code = (error as AxiosError<{ errorCode?: number }>).response?.data?.errorCode;
			if (code === ABODE_GATEWAY_UNREACHABLE) {
				throw new Error("Abode could not reach the gateway (error 2191). Try again in a moment.");
			}
			throw error;
		}
	}
}

export const describeError = (error: unknown): string => {
	if (axios.isAxiosError(error)) {
		const data = error.response?.data as { message?: string; errorCode?: number } | undefined;
		const status = error.response?.status;
		if (data?.message) return `${data.message}${status ? ` (HTTP ${status})` : ""}`;
		if (status) return `HTTP ${status}`;
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
};

const parseSetCookie = (cookies: string[] | string | undefined): Record<string, string> => {
	const list = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
	const result: Record<string, string> = {};
	for (const cookie of list) {
		const pair = cookie.split(";")[0];
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		const key = decodeURIComponent(pair.slice(0, eq).trim());
		if (!(key in result)) result[key] = decodeURIComponent(pair.slice(eq + 1).trim());
	}
	return result;
};
