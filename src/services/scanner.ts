'use strict';

import * as path from 'path';
import * as fs from 'fs';

import * as readdir from 'readdir-enhanced';
import * as micromatch from 'micromatch';

import { StorageService, IStorageItem } from './storage';
import { parseDependencies } from '../parser/dependencies';
import * as pathUtils from '../utils/paths';
import * as fsUtils from '../utils/fs';

import { IOptions } from '../emitty';
import { ILanguage } from './config';

export interface IFile {
	filepath: string;
	ctime: number;
}

export class ScannerService {

	private changedFile: string;
	private excludePatterns: string[] = [];

	constructor(private root: string, private storage: StorageService, private language: ILanguage, private options: IOptions) {
		this.excludePatterns = this.options.scanner.exclude;
	}

	public scan(filepath?: string, stats?: fs.Stats): Promise<any> {
		if (filepath && this.storage.keys().length !== 0) {
			return this.scanFile(filepath, stats);
		}

		return this.scanDirectory();
	}

	private scanFile(filepath: string, stats: fs.Stats): Promise<any> {
		let statPromise: Promise<fs.Stats>;

		statPromise = fsUtils.pathExists(filepath).then((exists) => {
			if (exists) {
				return stats
					? Promise.resolve(stats)
					: fsUtils.statFile(filepath);
			}

			return Promise.reject();
		});

		return statPromise.then((stat) => {
			const entry = this.makeEntryFile(filepath, stat.ctime);
			return this.makeDependenciesForDocument(entry);
		});
	}

	/**
	 * Scans directory and saves the dependencies for each file in the Storage.
	 */
	private scanDirectory(): Promise<string> {
		const listOfPromises: Promise<any>[] = [];

		// Drop previous changed file
		this.changedFile = null;

		return new Promise((resolve) => {
			const stream = readdir.readdirStreamStat(this.root, {
				basePath: pathUtils.relative(process.cwd(), this.root),
				filter: (stat) => this.scannerFilter(stat),
				deep: this.options.scanner.depth
			});

			stream.on('data', () => {
				// Because Stream
			});

			stream.on('file', (stat: readdir.IEntry) => {
				const entry = this.makeEntryFile(stat.path, stat.ctime);

				// Return Cache if it exists and not outdated
				const entryFilePath = pathUtils.relative(process.cwd(), entry.filepath);
				const cached = this.storage.get(entryFilePath);
				if (cached && cached.ctime >= entry.ctime) {
					listOfPromises.push(Promise.resolve(cached));
					return;
				}

				this.changedFile = entryFilePath;
				listOfPromises.push(this.makeDependenciesForDocument(entry));
			});

			stream.on('end', () => {
				Promise.all(listOfPromises).then(() => {
					resolve(this.changedFile);
				});
			});
		});
	}

	private makeDependenciesForDocument(entry: IFile): Promise<any> {
		// Remove base path
		const entryFilePath = pathUtils.relative(process.cwd(), entry.filepath);
		const entryDir = path.dirname(entryFilePath);

		return fsUtils.readFile(entry.filepath).then((data) => {
			const item = <IStorageItem>{
				dependencies: parseDependencies(data, this.language),
				ctime: entry.ctime
			};

			// Calculating the path relative to the root directory
			const dependencies: string[] = [];

			for (let i = 0; i < item.dependencies.length; i++) {
				const dependency = item.dependencies[i];

				let filepath = dependency;

				// Add default extension
				if (!path.extname(dependency)) {
					filepath += this.language.extensions[0];
				}

				// Push partial dependency filepath to dependencies
				if (this.language.partials && !dependency.startsWith('_')) {
					const parsedPath = path.parse(dependency);
					const buildedPath = path.format(Object.assign(parsedPath, <path.ParsedPath>{
						base: '_' + parsedPath.base
					}));

					dependencies.push(this.makeDependencyPath(entryDir, buildedPath));
				}

				dependencies.push(this.makeDependencyPath(entryDir, filepath));
			}

			item.dependencies = dependencies;

			this.storage.set(entryFilePath, item);
		});
	}

	private makeDependencyPath(entryDir: string, filepath: string): string {
		if (filepath.startsWith('/') && this.options.basedir) {
			return pathUtils.join(this.options.basedir, filepath);
		}

		return pathUtils.join(entryDir, filepath);
	}

	private makeEntryFile(filepath: string, ctime: Date): IFile {
		return {
			filepath,
			ctime: ctime.getTime()
		};
	}

	private scannerFilter(stat: readdir.IEntry) {
		if (this.excludePatterns && micromatch(stat.path, this.excludePatterns).length !== 0) {
			return false;
		} else if (stat.isFile()) {
			return this.language.extensions.indexOf(path.extname(stat.path)) !== -1;
		}
		return true;
	}

}
