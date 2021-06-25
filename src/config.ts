/* Copyright (c) 2020 - 2021, Nordic Semiconductor ASA
 *
 * All rights reserved.
 *
 * Use in source and binary forms, redistribution in binary form only, with
 * or without modification, are permitted provided that the following conditions
 * are met:
 *
 * 1. Redistributions in binary form, except as embedded into a Nordic
 *    Semiconductor ASA integrated circuit in a product or a software update for
 *    such product, must reproduce the above copyright notice, this list of
 *    conditions and the following disclaimer in the documentation and/or other
 *    materials provided with the distribution.
 *
 * 2. Neither the name of Nordic Semiconductor ASA nor the names of its
 *    contributors may be used to endorse or promote products derived from this
 *    software without specific prior written permission.
 *
 * 3. This software, with or without modification, must only be used with a Nordic
 *    Semiconductor ASA integrated circuit.
 *
 * 4. Any software provided in binary form under this license must not be reverse
 *    engineered, decompiled, modified and/or disassembled.
 *
 * THIS SOFTWARE IS PROVIDED BY NORDIC SEMICONDUCTOR ASA "AS IS" AND ANY EXPRESS OR
 * IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
 * MERCHANTABILITY, NONINFRINGEMENT, AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL NORDIC SEMICONDUCTOR ASA OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
 * TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import * as vscode from 'vscode';

const settingsNamespace = 'devicetree';

/**
 * All config entries under the settings namespace and their types:
 * Note that values without defaults in the manifest may be `null`.
 *
 * See `package.json` for ncs to see the information on each property.
 */
interface ConfigEntries {
    modules: string[];
    west: string | null;
    zephyr: string | null;
    ctxFile: string | null;
    defaultBoard: string | null;
}

type ConfigId = keyof ConfigEntries;

/**
 * This class provides typed access to all configuration variables under the configured settings namespace,
 * as well as onChange events and a couple of utility functions.
 */
class ConfigurationReader implements vscode.Disposable {
    private _updateSubscription: vscode.Disposable;
    private _config: vscode.WorkspaceConfiguration;
    private _emitters: { [id: string]: vscode.EventEmitter<ConfigId> };

    constructor() {
        this._config = vscode.workspace.getConfiguration(settingsNamespace);
        this._emitters = {};
        this._updateSubscription = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(settingsNamespace)) {
                this._config = vscode.workspace.getConfiguration(settingsNamespace);
                Object.entries(this._emitters)
                    .filter(([id]) => e.affectsConfiguration(this.id(id as ConfigId)))
                    .forEach(([id, emitter]) => emitter.fire(id as ConfigId));
            }
        });
    }

    private id<K extends ConfigId>(id: K): string {
        return `${settingsNamespace}.${id}`;
    }

    set<K extends ConfigId, T = ConfigEntries[K]>(
        id: K,
        value: T,
        target = vscode.ConfigurationTarget.Workspace
    ): Thenable<void> {
        return this._config.update(id, value, target);
    }

    get<K extends ConfigId, T = ConfigEntries[K]>(id: K): T {
        return this._config.get(id) as T;
    }

    onChange(id: ConfigId, cb: (id: ConfigId) => unknown): vscode.Disposable {
        if (!(id in this._emitters)) {
            this._emitters[id] = new vscode.EventEmitter<ConfigId>();
        }

        return this._emitters[id].event(cb);
    }

    dispose(): void {
        Object.values(this._emitters).forEach(emitter => emitter.dispose());
        this._updateSubscription.dispose();
    }

    /**
     * Open the settings UI focused on the given configuration ID.
     *
     * @param id Configuration ID
     */
    configureSetting<K extends ConfigId>(id: K) {
        vscode.commands.executeCommand('workbench.action.openSettings', this.id(id));
    }
}

/**
 * Configuration singleton that provides typed access to all configuration variables under the
 * configured settings namespace, as well as onChange events and a couple of utility functions.
 */
export const config = new ConfigurationReader();
