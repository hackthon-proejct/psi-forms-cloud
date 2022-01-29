
function dec2hex(str, pad) {
	pad = pad || 1;
	const dec = str.split('');
	const sum = [];
	const hex = [];
	while (dec.length > 0) {
		let s = 1 * dec.shift();
		for (let i = 0; s || i < sum.length; i++) {
			s += (sum[i] || 0) * 10;
			sum[i] = s % 16;
			s = (s - sum[i]) / 16;
		}
	}
	while (sum.length > 0) {
		hex.push(sum.pop().toString(16));
	}
	if (hex.length < pad) {
		for (let j = hex.length; j < pad; j++) {
			hex.unshift('0');
		}
	}
	return '0x' + hex.join('');
}

function compare(a, b) {
	if (a !== b) {
		console.log(`${a} !== ${b}`);
	}
}

compare(dec2hex('333188083674988730734363699376070604654', 32), '0xfaa9b0d4bf4e9e5c04c7e78d84b0376e');
compare(dec2hex('141762268197208927400326595132796356148', 32), '0x6aa66b7375b1dff47f03dd820552c634');
compare(dec2hex('171906415241758177432004280570236881297', 32), '0x8153f8a57460a98b3cad4ae42fc7c991');
compare(dec2hex('256', 32),                                     '0x00000000000000000000000000000100');
compare(dec2hex('0', 32),                                       '0x00000000000000000000000000000000');
compare(dec2hex('000000000000000000000000000000000000000', 32), '0x00000000000000000000000000000000');
