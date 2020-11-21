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