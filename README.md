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

```json
{
	"platform": "AbodePlus",
	"email": "YOUR_ABODE_ACCOUNT_EMAIL",
	"password": "YOUR_ABODE_ACCOUNT_PASSWORD",
	"mfaSecret": "YOUR_AUTHENTICATOR_SETUP_KEY"
}
```

| Option            | Default    | Description |
| ----------------- | ---------- | ----------- |
| `email`           |            | Abode account email. |
| `password`        |            | Abode account password. |
| `mfaSecret`       |            | Authenticator setup key, only if 2FA is on. See below. |
| `garageDoors`     | `true`     | Include garage doors. |
| `locks`           | `true`     | Include door locks. |
| `lights`          | `true`     | Include switches, dimmers and bulbs. |
| `switchType`      | `"switch"` | How on/off power switches appear: `"switch"`, `"lightbulb"` or `"outlet"`. |
| `exclude`         | `[]`       | Device names or IDs to leave out. |
| `pollingInterval` | `5`        | Minutes between backup full refreshes. `0` turns polling off. |

### Two-factor authentication

Abode's 2FA uses an authenticator app (Google Authenticator, 1Password, Authy…). A 6-digit code is only valid for 30 seconds, but Homebridge has to sign in again on its own (after restarts and when the session expires), so the plugin needs the **setup key** the codes are generated from. With that it produces a fresh code every time it signs in, just like your authenticator app.

To get the setup key:

1. In the Abode web app ([my.goabode.com](https://my.goabode.com)), open your account's security settings and find two-factor authentication.
2. If 2FA is already on, turn it off and on again to get a new QR code. (Your old authenticator entry will stop working; replace it with the new one.)
3. When the QR code appears, choose the option to enter the key manually / "can't scan" and copy the key (letters A–Z and digits 2–7, e.g. `JBSWY3DPEHPK3PXP`).
   - Password managers like 1Password show this key in the item's one-time-password field after you add the QR code.
4. Scan the QR code in your authenticator app as usual and finish enrolling.
5. Paste the key into **2FA Secret** (`mfaSecret`) in the plugin settings and restart Homebridge.

Treat the setup key like a password: anyone with it plus your password can sign in to your Abode account. The Homebridge host's clock must be accurate (NTP), since codes are time-based.

If 2FA is on and `mfaSecret` is missing, the log says so explicitly instead of failing silently.

## Migrating from homebridge-abode-garage-doors, -locks or -lights

This plugin replaces `homebridge-abode-garage-doors`, `homebridge-abode-locks` and `homebridge-abode-lights`. Uninstall those first, since running them alongside this one would add the same devices twice. HomeKit sees the devices as new accessories, so rooms, scenes and automations that used them need to be set up again.

### Recognition

Based on [homebridge-abode-locks](https://github.com/jasperpatterson/homebridge-abode-locks) by @jasperpatterson and [homebridge-abode-lights](https://github.com/chrisbsmith/homebridge-abode-lights) by @chrisbsmith.
