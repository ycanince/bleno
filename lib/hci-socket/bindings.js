var debug = require('debug')('bindings');

var events = require('events');
var util = require('util');
var os = require('os');

var AclStream = require('./acl-stream');
var Hci = require('./hci');
var Gap = require('./gap');
var Gatt = require('./gatt');

var BlenoBindings = function() {
  this._state = null;

  this._advertising = false;

  this._hci = new Hci();
  this._gap = new Gap(this._hci);
  this._profiles = [];
  this._services = [];
};

util.inherits(BlenoBindings, events.EventEmitter);

BlenoBindings.prototype.startAdvertising = function(name, serviceUuids) {
  this._advertising = true;

  this._gap.startAdvertising(name, serviceUuids);
};

BlenoBindings.prototype.startAdvertisingIBeacon = function(name, data) {
  this._advertising = true;

  this._gap.startAdvertisingIBeacon(name, data);
};

BlenoBindings.prototype.startAdvertisingWithEIRData = function(advertisementData, scanData) {
  this._advertising = true;

  this._gap.startAdvertisingWithEIRData(advertisementData, scanData);
};

BlenoBindings.prototype.stopAdvertising = function() {
  this._advertising = false;

  this._gap.stopAdvertising();
};

BlenoBindings.prototype.setServices = function(services) {
  this._services = services;

  this.emit('servicesSet');
};

BlenoBindings.prototype.disconnect = function(handle) {
  var profile = this._profiles.find((p)=>p.handle === handle);
  if (profile && profile.handle) {
    debug('disconnect by server');
    this._hci.disconnect(profile.handle);
  }
};
// todo handle
BlenoBindings.prototype.updateRssi = function(handle) {
  var profile = this._profiles.find((p)=>p.handle === handle);
  if (profile) {
    this._hci.readRssi(profile.handle);
  }
};

BlenoBindings.prototype.init = function() {
  this.onSigIntBinded = this.onSigInt.bind(this);

  process.on('SIGINT', this.onSigIntBinded);
  process.on('exit', this.onExit.bind(this));

  this._gap.on('advertisingStart', this.onAdvertisingStart.bind(this));
  this._gap.on('advertisingStop', this.onAdvertisingStop.bind(this));

  this._hci.on('stateChange', this.onStateChange.bind(this));
  this._hci.on('addressChange', this.onAddressChange.bind(this));
  this._hci.on('readLocalVersion', this.onReadLocalVersion.bind(this));

  this._hci.on('leConnComplete', this.onLeConnComplete.bind(this));
  this._hci.on('leConnUpdateComplete', this.onLeConnUpdateComplete.bind(this));
  this._hci.on('rssiRead', this.onRssiRead.bind(this));
  this._hci.on('disconnComplete', this.onDisconnComplete.bind(this));
  this._hci.on('encryptChange', this.onEncryptChange.bind(this));
  this._hci.on('leLtkNegReply', this.onLeLtkNegReply.bind(this));
  this._hci.on('aclDataPkt', this.onAclDataPkt.bind(this));

  this.emit('platform', os.platform());

  this._hci.init();
};

BlenoBindings.prototype.onStateChange = function(state) {
  if (this._state === state) {
    return;
  }
  this._state = state;

  if (state === 'unauthorized') {
    console.log('bleno warning: adapter state unauthorized, please run as root or with sudo');
    console.log('               or see README for information on running without root/sudo:');
    console.log('               https://github.com/sandeepmistry/bleno#running-on-linux');
  } else if (state === 'unsupported') {
    console.log('bleno warning: adapter does not support Bluetooth Low Energy (BLE, Bluetooth Smart).');
    console.log('               Try to run with environment variable:');
    console.log('               [sudo] BLENO_HCI_DEVICE_ID=x node ...');
  }

  this.emit('stateChange', state);
};

BlenoBindings.prototype.onAddressChange = function(address) {
  this.emit('addressChange', address);
};

BlenoBindings.prototype.onReadLocalVersion = function(hciVer, hciRev, lmpVer, manufacturer, lmpSubVer) {
};

BlenoBindings.prototype.onAdvertisingStart = function(error) {
  this.emit('advertisingStart', error);
};

BlenoBindings.prototype.onAdvertisingStop = function() {
  this.emit('advertisingStop');
};

BlenoBindings.prototype.onLeConnComplete = function(status, handle, role, addressType, address, interval, latency, supervisionTimeout, masterClockAccuracy) {
  if (role !== 1) {
    // not slave, ignore
    return;
  }

  var profile = {
    address:address,
    handle:handle,
    gatt: new Gatt(this._hci),
    aclStream: new AclStream(this._hci, handle, this._hci.addressType, this._hci.address, addressType, address)
  };
  profile.gatt.on('mtuChange', this.onMtuChange.bind(this));
  profile.gatt.setServices(this._services);
  profile.gatt.setAclStream(profile.aclStream);
  this._profiles.push(profile);
  this.emit('accept', address);
};

BlenoBindings.prototype.onLeConnUpdateComplete = function(handle, interval, latency, supervisionTimeout) {
  // no-op
};

BlenoBindings.prototype.onDisconnComplete = function(handle, reason) {
  var profile = this._profiles.find((p)=>p.handle === handle);

  if(profile.aclStream){
    profile.aclStream.push(null, null);
  }

  this._profiles = this._profiles.filter((p)=>p.handle !== handle);

  if (profile.address) {
    this.emit('disconnect', profile.address); // TODO: use reason
  }

  if (this._advertising) {
    this._gap.restartAdvertising();
  }
};

BlenoBindings.prototype.onEncryptChange = function(handle, encrypt) {
  var profile = this._profiles.find((p)=>p.handle === handle);
  if (profile && profile.aclStream) {
    profile.aclStream.pushEncrypt(encrypt);
  }
};

BlenoBindings.prototype.onLeLtkNegReply = function(handle) {
  var profile = this._profiles.find((p)=>p.handle === handle);
  if (profile && profile.aclStream) {
    profile.aclStream.pushLtkNegReply();
  }
};

BlenoBindings.prototype.onMtuChange = function(mtu) {
  this.emit('mtuChange', mtu);
};

BlenoBindings.prototype.onRssiRead = function(handle, rssi) {
  this.emit('rssiUpdate', rssi);
};

BlenoBindings.prototype.onAclDataPkt = function(handle, cid, data) {
  var profile = this._profiles.find((p)=>p.handle === handle);
  if (profile && profile.aclStream) {
      profile.aclStream.push(cid, data);
  }
};

BlenoBindings.prototype.onSigInt = function() {
  var sigIntListeners = process.listeners('SIGINT');

  if (sigIntListeners[sigIntListeners.length - 1] === this.onSigIntBinded) {
    // we are the last listener, so exit
    // this will trigger onExit, and clean up
    process.exit(1);
  }
};

BlenoBindings.prototype.onExit = function() {
  this._gap.stopAdvertising();
  this._profiles.forEach((p)=>{
    this.disconnect(p.handle);
  })
  
};

module.exports = new BlenoBindings();
