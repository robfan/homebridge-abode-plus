# Homebridge Abode Plus (homebridge-abode-plus)

[Homebridge](https://homebridge.io) plugin that brings [Abode](https://goabode.com) devices that Abode's built-in HomeKit support leaves out into HomeKit:

| Abode device                            | HomeKit accessory                    |
| --------------------------------------- | ------------------------------------ |
| Garage door (`secure_barrier`)          | Garage Door Opener                   |
| Door lock (`door_lock`)                 | Lock (with low-battery and jammed)   |
| Power switch (`power_switch_sensor`)    | Switch, Light or Outlet (your choice) |
| Dimmer (`dimmer_meter`)                 | Light with brightness                |
| Abode bulb / Hue (`light_bulb`, `hue`)  | Light with brightness, color and color temperature |

It works with accounts that have **two-factor authentication** turned on, and uses Abode's live event feed so changes made in the Abode app show up in HomeKit right away.

Supports Homebridge 1.8+ and 2.x on Node.js 20, 22 or 24.

_This is an unofficial integration not created by or affiliated with Abode Systems, Inc._

## Installation

In [Homebridge Config UI](https://github.com/homebridge/homebridge-config-ui-x), go to **Plugins**, search for `homebridge-abode-plus` and install it. Or from the command line:

```sh
npm install -g homebridge-abode-plus
```

## Configuration

Enter the email and password for your Abode account. A dedicated Abode user just for Homebridge is a good idea.

**Without two-factor authentication:**

```json
{
	"platform": "AbodePlus",
	"email": "YOUR_ABODE_ACCOUNT_EMAIL",
	"password": "YOUR_ABODE_ACCOUNT_PASSWORD"
}
```

**With two-factor authentication:**

```json
{
	"platform": "AbodePlus",
	"email": "YOUR_ABODE_ACCOUNT_EMAIL",
	"password": "YOUR_ABODE_ACCOUNT_PASSWORD",
	"useMfa": true,
	"mfaSecret": "JBSWY3DPEHPK3PXP"
}
```

| Option            | Default    | Description |
| ----------------- | ---------- | ----------- |
| `email`           |            | Abode account email. |
| `password`        |            | Abode account password. |
| `useMfa`          | `false`    | `true` if your Abode account uses two-factor authentication. Leave it off to sign in with just email and password. (Configs from before this option existed count as `true` when `mfaSecret` is filled in.) |
| `mfaSecret`       |            | The 2FA **setup key** (not a 6-digit code). Only used when `useMfa` is `true`. See below. |
| `garageDoors`     | `true`     | Include garage doors. |
| `locks`           | `true`     | Include door locks. |
| `lights`          | `true`     | Include switches, dimmers and bulbs. |
| `switchType`      | `"switch"` | How on/off power switches appear: `"switch"`, `"lightbulb"` or `"outlet"`. |
| `exclude`         | `[]`       | Device names or IDs to leave out. |
| `pollingInterval` | `5`        | Minutes between backup full refreshes. `0` turns polling off. |

### Two-factor authentication

> [!IMPORTANT]
> `mfaSecret` is the **2FA secret (setup key)**, a long code like `JBSWY3DPEHPK3PXP`.
> It is **not** the 6-digit one-time code (OTP) your authenticator app shows, like `482913`.
> A 6-digit code expires after 30 seconds, so the plugin couldn't use it to sign in again later. The plugin refuses to start if you enter one.

| | 2FA secret / setup key ✅ | One-time code (OTP) ❌ |
| --- | --- | --- |
| Looks like | `JBSWY3DPEHPK3PXP` (16+ letters A–Z and digits 2–7) | `482913` (6 digits) |
| Changes? | Never | Every 30 seconds |
| Where you see it | Once, when you set up 2FA (the "enter key manually" option under the QR code) | In your authenticator app, all the time |

Abode's 2FA uses an authenticator app (Google Authenticator, 1Password, Authy…). Homebridge has to sign in on its own after restarts and whenever the session expires, so it needs the secret your app generates codes from. With it, the plugin makes a fresh code every time it signs in, just like your app does.

To get the 2FA secret:

1. In the Abode web app ([my.goabode.com](https://my.goabode.com)), open your account's security settings and find two-factor authentication.
2. If 2FA is already on, turn it off and on again to get a new QR code. (Your old authenticator entry will stop working; replace it with the new one.)
3. Under the QR code, choose the option to enter the key manually ("can't scan?") and copy the key.
   - If you use 1Password: after adding the QR code to an item, edit the one-time password field; it holds an `otpauth://…` link. You can paste that whole link, and the plugin pulls the secret out of it.
4. Scan the QR code in your authenticator app as usual and finish enrolling.
5. In the plugin settings, turn on **Use two-factor authentication**, paste the key into **2FA Secret**, save, and restart Homebridge.

Treat the secret like a password: anyone with it and your password can sign in to your Abode account. The Homebridge host's clock must be accurate (NTP), since codes are time-based.

If your account requires 2FA and the plugin isn't set up for it, the log says so explicitly instead of failing silently.

To turn 2FA off in the plugin (for example, after turning it off in Abode), set `useMfa` to `false`. Any saved secret is then ignored.

## Migrating from homebridge-abode-garage-doors, -locks or -lights

This plugin replaces `homebridge-abode-garage-doors`, `homebridge-abode-locks` and `homebridge-abode-lights`. Uninstall those first, since running them alongside this one would add the same devices twice. HomeKit sees the devices as new accessories, so rooms, scenes and automations that used them need to be set up again.

### Recognition

Based on [homebridge-abode-locks](https://github.com/jasperpatterson/homebridge-abode-locks) by @jasperpatterson and [homebridge-abode-lights](https://github.com/chrisbsmith/homebridge-abode-lights) by @chrisbsmith.
