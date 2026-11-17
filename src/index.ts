import { API } from "homebridge";

import { AbodePlatform } from "./platform";
import { PLATFORM_NAME } from "./settings";

export = (api: API) => {
	api.registerPlatform(PLATFORM_NAME, AbodePlatform);
};
