const events = require('events');
const { spawn } = require('child_process');
const cec_client = spawn('cec-client', ['-d', '8']);
let Service,
	Characteristic,
	Log,
	Config,
	powerSwitch,
	justTurnedOff = false,
	justTurnedOn = false,
	currAddress,
	tvEvent = new events.EventEmitter(),
	nullFunction = function () {};

tvEvent.on('PowerOn', function () {
	Log.debug('Power Status: on');
	powerSwitch.getCharacteristic(Characteristic.On).updateValue(true);
	justTurnedOn = true;
	setTimeout(function () {justTurnedOn = false;}, 1000);
});

tvEvent.on('PowerOff', function () {
	Log.debug('Power Status: off');
	powerSwitch.getCharacteristic(Characteristic.On).updateValue(false);
	justTurnedOff = true;
	setTimeout(function () {justTurnedOff = false;}, 2000);
});

cec_client.stdout.on('data', function (data) {
	let traffic = data.toString();
	Log.debug(traffic);
	if (traffic.indexOf('<< 10:47:43:45:43') !== -1) {
		cec_client.stdin.write('tx 10:47:52:50:69\n'); // Set OSD String to 'RPi'
	}
	if (traffic.indexOf('>> 0f:36') !== -1) {
		tvEvent.emit('PowerOff');
	}
	if (traffic.indexOf('>> 01:90:00') !== -1) {
		if (!justTurnedOff) tvEvent.emit('PowerOn');
	}
});

module.exports = function (homebridge) {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;
	homebridge.registerPlatform('homebridge-hdmi-cec', 'CEC', CECPlatform);
};

function CECPlatform(log, config) {
	Log = log;
	Config = config;
}

CECPlatform.prototype = {
	accessories: function (callback) {
		let list = [new Power()];
		for (let i in Config.sources) {
			list.push(new Source(Config.sources[i]));
		}
		callback(list);
	}
};

function Power() {
	this.name = Config.name || 'TV';
}

Power.prototype = {
	getServices: function () {
		this.informationService = new Service.AccessoryInformation();
		this.informationService
			.setCharacteristic(Characteristic.Manufacturer, Config.manufacturer || 'Dominick Han')
			.setCharacteristic(Characteristic.Model, Config.model || 'TV')
			.setCharacteristic(Characteristic.SerialNumber, Config.serial || 'N/A');

		powerSwitch = new Service.Switch(this.name);
		powerSwitch
			.getCharacteristic(Characteristic.On)
			.on('get', this.getState.bind(this))
			.on('set', this.setState.bind(this));
		Log('Initialized Power Switch');

		return [this.informationService, powerSwitch];
	},

	getState: function (callback) {
		Log.debug('Power.getState()');
		if (justTurnedOn) {
			callback(null, true);
		} else if (justTurnedOff) {
			callback(null, false);
		} else {
			cec_client.stdin.write('tx 10:8f\n'); // 'pow 0'
			let activated = false;
			let handler = function () {
				activated = true;
				callback(null, true);
			};
			tvEvent.prependOnceListener('PowerOn', handler);
			setTimeout(function () {
				tvEvent.removeListener('PowerOn', handler);
				if (!activated) {
					callback(null, false);
					tvEvent.emit('PowerOff');
				}
			}, 300);
		}
	},

	setState: function (state, callback) {
		Log.debug(`Power.setState(${state})`);
		if (state === powerSwitch.getCharacteristic(Characteristic.On).value) {
			callback();
			this.getState(nullFunction);
		} else {
			let activated = false;
			let handler = function () {
				activated = true;
				callback(null);
			};

			// Send on or off signal
			cec_client.stdin.write(state ? 'tx 10:04\n' : 'tx 10:36\n');

			tvEvent.prependOnceListener(state ? 'PowerOn' : 'PowerOff', handler);
			setTimeout(function () {
				tvEvent.removeListener(state ? 'PowerOn' : 'PowerOff', handler);
				if (!activated) {
					callback('TV not responding');
				}
			}, 15000);
		}
	}
};

function Source(config) {
	this.name = config.name;
	let address = config.address.replace(/\D/g,'');
	if (address.length !== 4) {
		throw `${config.address} is not a valid physical address!`;
	}
	this.address = address.slice(0, 2) + ':' + address.slice(2);
	this.config = config;
}

Source.prototype = {
	getServices: function () {
		this.informationService = new Service.AccessoryInformation();
		this.informationService
			.setCharacteristic(Characteristic.Manufacturer, this.config.manufacturer || 'Dominick Han')
			.setCharacteristic(Characteristic.Model, this.config.model || 'TV')
			.setCharacteristic(Characteristic.SerialNumber, this.config.serial || this.address);

		this.switch = new Service.Switch(this.name);
		this.switch
			.getCharacteristic(Characteristic.On)
			.on('get', this.getState.bind(this))
			.on('set', this.setState.bind(this));
		Log(`Initialized Source: ${this.name} at ${this.address}`);

		return [this.informationService, this.switch];
	},

	getState: function (callback) {
		Log.debug(`${this.name}.getState()`);
		if (powerSwitch.getCharacteristic(Characteristic.On).value && this.address === currAddress) {
			callback(null, true);
		} else {
			callback(null, false);
		}
	},

	setState: function (state, callback) {
		Log.debug(`${this.name}.setState(${state})`);
		cec_client.stdin.write(`tx 1f:82:${this.address}\n`);
		cec_client.stdin.write(`is\n`);
		setTimeout(() => {this.switch.getCharacteristic(Characteristic.On).updateValue(false);}, 500);
		callback();
	}
};