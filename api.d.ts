/*
 * Copyright (c) 2021 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from "vscode";

/** Tree view information item */
export interface InfoItem extends vscode.TreeItem {
    children: InfoItem[];
}

/**
 * DeviceTree file object.
 * Represents a single file on disk that has been included in the build.
 */
export interface File {
    /** Uri of the file on disk */
    uri: vscode.Uri;
    /** Files included from this file by the preprocessor */
    includes: File[];
}

/**
 * DeviceTree context.
 *
 * Represents a single build configuration of an application.
 */
export interface Context {
    /** Array of overlay files */
    overlays: File[];
    /** The board file used as a base */
    boardFile: File;
    /** Name of the context */
    name: string;
    /** Context ID number. Can be used to manipulate the context later. */
    id: number;
}

interface IconLocation {
    /** Absolute path of dark theme variant of this icon */
    dark: string;
    /** Absolute path of light theme variant of this icon */
    light: string;
}

export interface DeviceTree {
    /**
     * DeviceTree context change event.
     * Any tree views should be refreshed.
     */
    onChange: vscode.Event<Context>;
    /**
     * Paths for all icons exported by this extension.
     */
    icons: {
        dts: IconLocation;
        adc: IconLocation;
        bus: IconLocation;
        board: IconLocation;
        clock: IconLocation;
        dac: IconLocation;
        flash: IconLocation;
        gpio: IconLocation;
        interrupts: IconLocation;
        overlay: IconLocation;
        shield: IconLocation;
        addShield: IconLocation;
        removeShield: IconLocation;
    };
    /** Current version number */
    version: number;

    /**
     * Set Zephyr base directory to use.
     *
     * @param uri New Zephyr base
     */
    setZephyrBase(uri: vscode.Uri): Promise<void>;

    /**
     * Create a new context object.
     * A context corresponds to a single application build.
     *
     * @param boardFile Uri of the board file.
     * @param overlays Array of overlay file uris.
     * @param name Name of this context, or undefined.
     *
     * @returns A DeviceTree context object.
     */
    addContext(
        boardFile: vscode.Uri,
        overlays?: vscode.Uri[],
        name?: string
    ): Promise<Context>;

    /**
     * Remove a context object.
     *
     * @param id ID of the context.
     */
    removeContext(id: number): void;

    /**
     * Replace a context's overlays.
     *
     * @param id ID of the context.
     * @param overlays List of overlay file URIs.
     */
    setOverlays(id: number, overlays: vscode.Uri[]): void;

    /**
     * Get a context object.
     *
     * @param id ID of the context.
     */
    getContext(id: number): Context | undefined;

    /**
     * Get a tree of information for this context.
     *
     *
     * The tree is identical to the "Overview" sidebar tree rendered under the
     * DeviceTree view, presenting meta information about the DeviceTree context.
     *
     * Some tree nodes set the contextValue field to attach buttons to the node.
     * To remove buttons, reset the contextValue field before passing the node to
     * VS Code for rendering.
     *
     * Tree nodes include their child nodes in an array, which can be used to
     * respond to the getChildNodes callback in TreeviewProviders.
     *
     * @param id ID of the context.
     */
    getDetails(id: number): InfoItem | undefined;

    /**
     * Show a preview of the compiled DeviceTree output in a new editor.
     *
     * @param id ID of the context.
     * @param options Optional preview options
     */
    preview(id: number, options?: vscode.TextDocumentShowOptions): void;
}
