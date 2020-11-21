/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */

export function countText(count: number, text: string, plural?: string): string {
	if (!plural) {
		plural = text + 's';
	}

	let out = count.toString() + ' ';
	if (count === 1) {
		out += text;
	} else {
		out += plural;
	}

	return out;
}

export function capitalize(str: string): string {
	return str.replace(/([a-z])(\w+)/g, (word, first: string, rest: string) => {
		const acronyms = [
			'ADC', 'DAC', 'GPIO', 'SPI', 'I2C', 'RX', 'TX', 'DMA',
		];
		if (acronyms.includes(word.toUpperCase())) {
			return word.toUpperCase();
		}
		return first.toUpperCase() + rest;
	});
}