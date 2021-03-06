import * as _ from "lodash";
import * as path from "path";
import { CancellationToken, Location, SymbolInformation, Uri, workspace, WorkspaceSymbolProvider } from "vscode";
import * as as from "../analysis/analysis_server_types";
import { Analyzer, getSymbolKindForElementKind } from "../analysis/analyzer";
import { fsPath, toRange } from "../utils";

export class DartWorkspaceSymbolProvider implements WorkspaceSymbolProvider {
	private badChars: RegExp = new RegExp("[^0-9a-z\-]", "gi");
	constructor(public readonly analyzer: Analyzer) { }

	public async provideWorkspaceSymbols(query: string, token: CancellationToken): Promise<SymbolInformation[] | null> {
		if (query.length === 0)
			return null;

		// Turn query into a case-insensitive fuzzy search.
		const pattern = ".*" + query.replace(this.badChars, "").split("").map((c) => `[${c.toUpperCase()}${c.toLowerCase()}]`).join(".*") + ".*";
		const results = await this.analyzer.searchGetElementDeclarations({ pattern, maxResults: 500 });

		return results.declarations.map((d) => this.convertWorkspaceResult(d, results.files[d.fileIndex]));
	}

	public async resolveWorkspaceSymbol(symbol: SymbolInformation, token: CancellationToken): Promise<SymbolInformation> {
		if (!(symbol instanceof PartialSymbolInformation))
			return;

		const document = await workspace.openTextDocument(Uri.file(symbol.locationData.file));
		symbol.location = new Location(
			document.uri,
			toRange(document, symbol.locationData.offset, symbol.locationData.length),
		);

		return symbol;
	}

	private convertWorkspaceResult(result: as.ElementDeclaration, file: string): SymbolInformation {
		const names = this.getNames(result, true, file);

		const symbol: any = new PartialSymbolInformation(
			names.name,
			getSymbolKindForElementKind(result.kind),
			names.containerName,
			new Location(Uri.file(file), undefined),
		);

		symbol.locationData = {
			file,
			length: result.codeLength,
			offset: result.codeOffset,
		};

		return symbol;
	}

	private getNames(result: as.ElementDeclaration, includeFilename: boolean, file: string) {
		let name = result.name;
		// Constructors don't come prefixed with class name, so add them for a nice display:
		//    () => MyClass()
		//    named() => MyClass.named()
		let nameIsPrefixedWithClass = false;
		if (result.kind === "CONSTRUCTOR" && result.className) {
			if (name) {
				nameIsPrefixedWithClass = true;
				name = `${result.className}.${name}`;
			} else {
				name = result.className;
			}
		}
		if (result.parameters && result.kind !== "SETTER")
			name += result.parameters;
		let containerName: string;
		if (includeFilename) {
			containerName = this.createDisplayPath(file);
			if (result.className && !nameIsPrefixedWithClass)
				name = `${result.className}.${name}`;
		} else {
			containerName = result.className;
		}
		return { name, containerName };
	}

	private createDisplayPath(inputPath: string): string {
		// HACK: The AS returns paths to the PUB_CACHE folder, which Code can't
		// convert to relative paths (so they look terrible). If the file exists in
		// workspace.rootPath we rewrite the path to there which gives us a nice
		// relative path.

		const root = workspace.getWorkspaceFolder(Uri.file(inputPath));
		if (root) {
			inputPath = root && path.relative(fsPath(root.uri), inputPath);
		} else {
			const pathSlash = _.escapeRegExp(path.sep);
			const notSlashes = `[^${pathSlash}]+`;
			const pattern = new RegExp(`.*${pathSlash}(?:hosted${pathSlash}${notSlashes}|git)${pathSlash}(${notSlashes})${pathSlash}(.*)`);
			const matches = pattern.exec(inputPath);
			if (matches && matches.length === 3) {
				// Packages in pubcache are versioned so trim the "-x.x.x" off the end of the foldername.
				const packageName = matches[1].split("-")[0];

				// Trim /lib/ off the start if present.
				const filePath = matches[2].startsWith(`lib${path.sep}`) ? matches[2].substr(4) : matches[2];

				// Return 'package:foo/bar.dart'.
				inputPath = `package:${packageName}/${filePath.replace(/\\/g, "/")}`;
			} else {
				return undefined;
			}
		}
		return inputPath;
	}
}

class PartialSymbolInformation extends SymbolInformation {
	public locationData: {
		file: string;
		offset: number;
		length: number;
	};
}
