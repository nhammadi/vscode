/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import { IDisposable } from 'vs/base/common/lifecycle';
import { guessMimeTypes } from 'vs/base/common/mime';
import paths = require('vs/base/common/paths');
import URI from 'vs/base/common/uri';
import { ConfigurationSource, IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IKeybindingService, KeybindingSource } from 'vs/platform/keybinding/common/keybinding';
import { ILifecycleService, ShutdownReason } from 'vs/platform/lifecycle/common/lifecycle';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { ITelemetryService, ITelemetryExperiments, ITelemetryInfo, ITelemetryData } from 'vs/platform/telemetry/common/telemetry';
import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import * as objects from 'vs/base/common/objects';

export const defaultExperiments: ITelemetryExperiments = {
	showNewUserWatermark: false,
	openUntitledFile: true,
	enableWelcomePage: true,
	mergeQuickLinks: false,
};

export const NullTelemetryService = {
	_serviceBrand: undefined,
	_experiments: defaultExperiments,
	publicLog(eventName: string, data?: ITelemetryData) {
		return TPromise.as<void>(null);
	},
	isOptedIn: true,
	getTelemetryInfo(): TPromise<ITelemetryInfo> {
		return TPromise.as({
			instanceId: 'someValue.instanceId',
			sessionId: 'someValue.sessionId',
			machineId: 'someValue.machineId'
		});
	},
	getExperiments(): ITelemetryExperiments {
		return this._experiments;
	}
};

export function loadExperiments(accessor: ServicesAccessor): ITelemetryExperiments {
	const contextService = accessor.get(IWorkspaceContextService);
	const storageService = accessor.get(IStorageService);
	const configurationService = accessor.get(IConfigurationService);

	updateExperimentsOverrides(configurationService, storageService);
	configurationService.onDidUpdateConfiguration(e => updateExperimentsOverrides(configurationService, storageService));

	let {
		showNewUserWatermark,
		openUntitledFile,
		enableWelcomePage,
		mergeQuickLinks,
	} = splitExperimentsRandomness(storageService);

	const newUserDuration = 24 * 60 * 60 * 1000;
	const firstSessionDate = storageService.get('telemetry.firstSessionDate');
	const isNewUser = !firstSessionDate || Date.now() - Date.parse(firstSessionDate) < newUserDuration;
	if (!isNewUser || contextService.hasWorkspace()) {
		showNewUserWatermark = defaultExperiments.showNewUserWatermark;
		openUntitledFile = defaultExperiments.openUntitledFile;
	}

	return applyOverrides({
		showNewUserWatermark,
		openUntitledFile,
		enableWelcomePage,
		mergeQuickLinks,
	}, storageService);
}

export function isWelcomePageEnabled(storageService: IStorageService) {
	const overrides = getExperimentsOverrides(storageService);
	return 'enableWelcomePage' in overrides ? overrides.enableWelcomePage : splitExperimentsRandomness(storageService).enableWelcomePage;
}

function applyOverrides(experiments: ITelemetryExperiments, storageService: IStorageService): ITelemetryExperiments {
	const experimentsConfig = getExperimentsOverrides(storageService);
	Object.keys(experiments).forEach(key => {
		if (key in experimentsConfig) {
			experiments[key] = experimentsConfig[key];
		}
	});
	return experiments;
}

function splitExperimentsRandomness(storageService: IStorageService): ITelemetryExperiments {
	const random1 = getExperimentsRandomness(storageService);
	const [random2, showNewUserWatermark] = splitRandom(random1);
	const [random3, openUntitledFile] = splitRandom(random2);
	const [random4, mergeQuickLinks] = splitRandom(random3);
	const [, enableWelcomePage] = splitRandom(random4);
	return {
		showNewUserWatermark,
		openUntitledFile,
		enableWelcomePage,
		mergeQuickLinks,
	};
}

const GLOBAL_PREFIX = `storage://global/`; // TODO@Christoph debt, why do you need to know? just use the storageservice?

function getExperimentsRandomness(storageService: IStorageService) {
	const key = GLOBAL_PREFIX + 'experiments.randomness';
	let valueString = storageService.get(key);
	if (!valueString) {
		valueString = Math.random().toString();
		storageService.store(key, valueString);
	}

	return parseFloat(valueString);
}

function splitRandom(random: number): [number, boolean] {
	const scaled = random * 2;
	const i = Math.floor(scaled);
	return [scaled - i, i === 1];
}

const experimentsOverridesKey = GLOBAL_PREFIX + 'experiments.overrides';

function getExperimentsOverrides(storageService: IStorageService): ITelemetryExperiments {
	const valueString = storageService.get(experimentsOverridesKey);
	return valueString ? JSON.parse(valueString) : <any>{};
}

function updateExperimentsOverrides(configurationService: IConfigurationService, storageService: IStorageService) {
	const storageOverrides = getExperimentsOverrides(storageService);
	const config: any = configurationService.getConfiguration('telemetry');
	const configOverrides = config && config.experiments || {};
	if (!objects.equals(storageOverrides, configOverrides)) {
		storageService.store(experimentsOverridesKey, JSON.stringify(configOverrides));
	}
}

export interface ITelemetryAppender {
	log(eventName: string, data: any): void;
}

export function combinedAppender(...appenders: ITelemetryAppender[]): ITelemetryAppender {
	return { log: (e, d) => appenders.forEach(a => a.log(e, d)) };
}

export const NullAppender: ITelemetryAppender = { log: () => null };

// --- util

export function anonymize(input: string): string {
	if (!input) {
		return input;
	}

	let r = '';
	for (let i = 0; i < input.length; i++) {
		let ch = input[i];
		if (ch >= '0' && ch <= '9') {
			r += '0';
			continue;
		}
		if (ch >= 'a' && ch <= 'z') {
			r += 'a';
			continue;
		}
		if (ch >= 'A' && ch <= 'Z') {
			r += 'A';
			continue;
		}
		r += ch;
	}
	return r;
}

export interface URIDescriptor {
	mimeType?: string;
	ext?: string;
	path?: string;
}

export function telemetryURIDescriptor(uri: URI): URIDescriptor {
	const fsPath = uri && uri.fsPath;
	return fsPath ? { mimeType: guessMimeTypes(fsPath).join(', '), ext: paths.extname(fsPath), path: anonymize(fsPath) } : {};
}

/**
 * Only add settings that cannot contain any personal/private information of users (PII).
 */
const configurationValueWhitelist = [
	'editor.tabCompletion',
	'editor.fontFamily',
	'editor.fontWeight',
	'editor.fontSize',
	'editor.lineHeight',
	'editor.letterSpacing',
	'editor.lineNumbers',
	'editor.rulers',
	'editor.wordSeparators',
	'editor.tabSize',
	'editor.insertSpaces',
	'editor.detectIndentation',
	'editor.roundedSelection',
	'editor.scrollBeyondLastLine',
	'editor.minimap.enabled',
	'editor.minimap.renderCharacters',
	'editor.minimap.maxColumn',
	'editor.find.seedSearchStringFromSelection',
	'editor.find.autoFindInSelection',
	'editor.wordWrap',
	'editor.wordWrapColumn',
	'editor.wrappingIndent',
	'editor.mouseWheelScrollSensitivity',
	'editor.multiCursorModifier',
	'editor.quickSuggestions',
	'editor.quickSuggestionsDelay',
	'editor.parameterHints',
	'editor.autoClosingBrackets',
	'editor.autoindent',
	'editor.formatOnType',
	'editor.formatOnPaste',
	'editor.suggestOnTriggerCharacters',
	'editor.acceptSuggestionOnEnter',
	'editor.acceptSuggestionOnCommitCharacter',
	'editor.snippetSuggestions',
	'editor.emptySelectionClipboard',
	'editor.wordBasedSuggestions',
	'editor.suggestFontSize',
	'editor.suggestLineHeight',
	'editor.selectionHighlight',
	'editor.occurrencesHighlight',
	'editor.overviewRulerLanes',
	'editor.overviewRulerBorder',
	'editor.cursorBlinking',
	'editor.cursorStyle',
	'editor.mouseWheelZoom',
	'editor.fontLigatures',
	'editor.hideCursorInOverviewRuler',
	'editor.renderWhitespace',
	'editor.renderControlCharacters',
	'editor.renderIndentGuides',
	'editor.renderLineHighlight',
	'editor.codeLens',
	'editor.folding',
	'editor.showFoldingControls',
	'editor.matchBrackets',
	'editor.glyphMargin',
	'editor.useTabStops',
	'editor.trimAutoWhitespace',
	'editor.stablePeek',
	'editor.dragAndDrop',
	'editor.formatOnSave',

	'window.zoomLevel',
	'files.autoSave',
	'files.hotExit',
	'typescript.check.tscVersion',
	'files.associations',
	'workbench.statusBar.visible',
	'files.trimTrailingWhitespace',
	'git.confirmSync',
	'workbench.sideBar.location',
	'window.openFilesInNewWindow',
	'javascript.validate.enable',
	'window.reopenFolders',
	'window.restoreWindows',
	'extensions.autoUpdate',
	'files.eol',
	'explorer.openEditors.visible',
	'workbench.editor.enablePreview',
	'files.autoSaveDelay',
	'workbench.editor.showTabs',
	'files.encoding',
	'files.autoGuessEncoding',
	'git.enabled',
	'http.proxyStrictSSL',
	'terminal.integrated.fontFamily',
	'workbench.editor.enablePreviewFromQuickOpen',
	'workbench.editor.swipeToNavigate',
	'php.builtInCompletions.enable',
	'php.validate.enable',
	'php.validate.run',
	'workbench.welcome.enabled',
];

export function configurationTelemetry(telemetryService: ITelemetryService, configurationService: IConfigurationService): IDisposable {
	return configurationService.onDidUpdateConfiguration(event => {
		if (event.source !== ConfigurationSource.Default) {
			telemetryService.publicLog('updateConfiguration', {
				configurationSource: ConfigurationSource[event.source],
				configurationKeys: flattenKeys(event.sourceConfig)
			});
			telemetryService.publicLog('updateConfigurationValues', {
				configurationSource: ConfigurationSource[event.source],
				configurationValues: flattenValues(event.sourceConfig, configurationValueWhitelist)
			});
		}
	});
}

export function lifecycleTelemetry(telemetryService: ITelemetryService, lifecycleService: ILifecycleService): IDisposable {
	return lifecycleService.onShutdown(event => {
		telemetryService.publicLog('shutdown', { reason: ShutdownReason[event] });
	});
}

export function keybindingsTelemetry(telemetryService: ITelemetryService, keybindingService: IKeybindingService): IDisposable {
	return keybindingService.onDidUpdateKeybindings(event => {
		if (event.source === KeybindingSource.User && event.keybindings) {
			telemetryService.publicLog('updateKeybindings', {
				bindings: event.keybindings.map(binding => ({
					key: binding.key,
					command: binding.command,
					when: binding.when,
					args: binding.args ? true : undefined
				}))
			});
		}
	});
}

function flattenKeys(value: Object): string[] {
	if (!value) {
		return [];
	}
	const result: string[] = [];
	flatKeys(result, '', value);
	return result;
}

function flatKeys(result: string[], prefix: string, value: Object): void {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		Object.keys(value)
			.forEach(key => flatKeys(result, prefix ? `${prefix}.${key}` : key, value[key]));
	} else {
		result.push(prefix);
	}
}

function flattenValues(value: Object, keys: string[]): { [key: string]: any }[] {
	if (!value) {
		return [];
	}

	return keys.reduce((array, key) => {
		const v = key.split('.')
			.reduce((tmp, k) => tmp && typeof tmp === 'object' ? tmp[k] : undefined, value);
		if (typeof v !== 'undefined') {
			array.push({ [key]: v });
		}
		return array;
	}, []);
}
