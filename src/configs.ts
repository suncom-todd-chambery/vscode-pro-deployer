import * as jsonc from "jsonc-parser";
import { TextEncoder } from "util";
import * as vscode from "vscode";
import { Extension } from "./extension";
import { ConfigsInterface, TargetOptionsInterface } from "./targets/Interfaces";
import fs = require("fs");

export class Configs {
    private static readonly CONFIG_FILE_NAME_JSONC = "pro-deployer.jsonc";
    private static readonly CONFIG_FILE_NAME_JSON = "pro-deployer.json";

    public static readonly sampleConfig: ConfigsInterface = {
        enableStatusBarItem: true,
        enableQuickPick: true,
        uploadOnSave: true,
        ignoreSourceParentPaths: false,
        autoDelete: true,
        checkGitignore: false,
        reconnectOnTimeout: true,
        pauseDuringGitOperations: true,
        activeTargets: ["My SFTP"],
        concurrency: 5,
        ignore: [".git/**/*", ".vscode/**/*"],
        include: [],
        targets: [
            {
                name: "My SFTP",
                type: "sftp",
                host: "localhost",
                port: 22,
                user: "admin",
                password: "123456",
                dir: "/",
                baseDir: "/",
                privateKey: null,
                passphrase: null,
            },
            {
                name: "My FTP",
                type: "ftp",
                host: "localhost",
                port: 21,
                user: "admin",
                password: "123456",
                dir: "/",
                baseDir: "/",
                transferDataType: "binary",
            },
        ] as TargetOptionsInterface[],
    };

    public static readonly defaultConfigs: ConfigsInterface = {
        enableStatusBarItem: true,
        enableQuickPick: true,
        autoDelete: true,
        uploadOnSave: true,
        ignoreSourceParentPaths: false,
        checkGitignore: false,
        concurrency: 5,
        reconnectOnTimeout: true,
        pauseDuringGitOperations: true,
        ignore: [".git/**/*", ".vscode/**/*"],
        include: [],
        activeTargets: [],
        targets: [],
    };
    private static configs: ConfigsInterface = Configs.defaultConfigs;
    private static workspaceConfigs: { [index: string]: ConfigsInterface; } = {};

    private static getConfigUri(workspaceFolder: vscode.WorkspaceFolder, fileName: string): vscode.Uri {
        return vscode.Uri.file(workspaceFolder.uri.path + "/.vscode/" + fileName);
    }

    private static getWorkspaceConfigFile(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
        const jsoncFile = this.getConfigUri(workspaceFolder, this.CONFIG_FILE_NAME_JSONC);
        const jsonFile = this.getConfigUri(workspaceFolder, this.CONFIG_FILE_NAME_JSON);

        if (fs.existsSync(jsoncFile.fsPath)) {
            return jsoncFile;
        }
        if (fs.existsSync(jsonFile.fsPath)) {
            return jsonFile;
        }

        return jsoncFile;
    }

    public static getConfigs() {
        return this.configs;
    }
    public static getConfigFile(): vscode.Uri {
        const workspaceFolder = Extension.getActiveWorkspaceFolder();
        if (!workspaceFolder) {
            return vscode.Uri.file("/.vscode/" + this.CONFIG_FILE_NAME_JSONC);
        }

        return this.getWorkspaceConfigFile(workspaceFolder);
    }
    public static getWorkspaceConfigs(uri?: vscode.Uri): ConfigsInterface {
        if (uri) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            if (workspaceFolder) {
                return this.workspaceConfigs[workspaceFolder.uri.path] ?? this.configs;
            }
        }
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            const activeDocumentUri = activeEditor.document.uri;
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeDocumentUri);
            if (workspaceFolder) {
                return this.workspaceConfigs[workspaceFolder.uri.path] ?? this.configs;
            }
        }
        return this.configs;
    }
    public static getWorkspaceConfigFiles(): vscode.Uri[] {
        const files = [] as vscode.Uri[];
        if (vscode.workspace.workspaceFolders) {
            vscode.workspace.workspaceFolders.forEach((folder) => {
                files.push(this.getWorkspaceConfigFile(folder));
            });
        }
        return files;
    }
    public static getAllTargetOptions(): {
        options: TargetOptionsInterface;
        workspaceFolder: vscode.WorkspaceFolder;
    }[] {
        const targets = [] as { options: TargetOptionsInterface; workspaceFolder: vscode.WorkspaceFolder; }[];
        Object.keys(this.workspaceConfigs).forEach((key) => {
            if (this.workspaceConfigs[key].targets) {
                this.workspaceConfigs[key].targets?.forEach((target) => {
                    targets.push({
                        options: target,
                        workspaceFolder: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(key))!,
                    });
                });
            }
        });
        return targets;
    }
    public static getGitignoreFile(): vscode.Uri {
        return vscode.Uri.file(Extension.getActiveWorkspaceFolder()?.uri.path + "/.gitignore");
    }
    public static generateConfigFile() {
        if (!Extension.getActiveWorkspaceFolder()) {
            Extension.showErrorMessage("Can't get active workspace folder.");
            return;
        }

        const configFile = vscode.Uri.file(
            Extension.getActiveWorkspaceFolder()?.uri.path + "/.vscode/" + this.CONFIG_FILE_NAME_JSONC
        );
        const legacyConfigFile = vscode.Uri.file(
            Extension.getActiveWorkspaceFolder()?.uri.path + "/.vscode/" + this.CONFIG_FILE_NAME_JSON
        );

        if (fs.existsSync(legacyConfigFile.fsPath) && !fs.existsSync(configFile.fsPath)) {
            Extension.showErrorMessage(
                "Legacy config file already exists. Rename it to .jsonc or remove it first. Path: " + legacyConfigFile.fsPath
            );
            return;
        }

        vscode.workspace.fs.stat(configFile).then(
            (fileStat) => {
                Extension.showErrorMessage("The config file is already exists! Path: " + configFile.fsPath);
            },
            (reason) => {
                vscode.workspace.fs
                    .writeFile(configFile, new TextEncoder().encode(JSON.stringify(this.sampleConfig, null, "\t")))
                    .then(
                        () => {
                            vscode.window.showTextDocument(configFile, {
                                preview: true,
                            });
                            vscode.window.showInformationMessage("The file has been generated successfully!");
                        },
                        (reason) => {
                            Extension.showErrorMessage("Can't generate config file. The file can't be written!");
                        }
                    );
            }
        );
    }
    public static init(cb: Function) {
        const promises = [] as Thenable<Uint8Array>[];
        this.getWorkspaceConfigFiles().forEach((file, index) => {
            const promise = vscode.workspace.fs.readFile(file);
            promises.push(promise);
            promise.then((value) => {
                let workspaceConfigs = Extension.extensionContext.workspaceState.get("configs");
                if (!workspaceConfigs) {
                    workspaceConfigs = {};
                }

                let fileConfigs = {} as ConfigsInterface;
                try {
                    const errors: jsonc.ParseError[] = [];
                    fileConfigs = jsonc.parse(value.toString(), errors);
                    if (errors.length > 0) {
                        Extension.showErrorMessage("Can't parse config file. Check config syntax.");
                        return;
                    }
                } catch (error) {
                    Extension.showErrorMessage("Can't parse config file. Check config syntax.");
                    return;
                }

                const configs = Object.assign({}, this.defaultConfigs, fileConfigs, workspaceConfigs);
                if (fileConfigs.ignore) {
                    configs.ignore = fileConfigs.ignore;
                }
                if (index === 0) {
                    this.configs = configs;
                }
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(file);
                if (workspaceFolder) {
                    this.workspaceConfigs[workspaceFolder.uri.path] = configs;
                }
                Extension.appendLineToOutputChannel("[INFO] The config file is loaded: " + JSON.stringify(configs));
            });
        });

        Promise.allSettled(promises).finally(() => {
            cb();
        });

        const disposables = vscode.workspace.onDidSaveTextDocument((e) => {
            if (
                vscode.workspace.asRelativePath(e.uri.path) ===
                vscode.workspace.asRelativePath(Configs.getConfigFile().path)
            ) {
                let workspaceConfigs = Extension.extensionContext.workspaceState.get("configs");
                if (!workspaceConfigs) {
                    workspaceConfigs = {};
                }

                let fileConfigs = {} as ConfigsInterface;
                try {
                    const errors: jsonc.ParseError[] = [];
                    fileConfigs = jsonc.parse(e.getText(), errors);
                    if (errors.length > 0) {
                        Extension.showErrorMessage("Can't parse config file. Check config syntax.");
                        return;
                    }
                } catch (error) {
                    Extension.showErrorMessage("Can't parse config file. Check config syntax.");
                    return;
                }
                this.configs = Object.assign({}, this.defaultConfigs, fileConfigs, workspaceConfigs);
                if (fileConfigs.ignore) {
                    this.configs.ignore = fileConfigs.ignore;
                }
                Extension.appendLineToOutputChannel(
                    "[INFO] The config file is updated: " + JSON.stringify(this.configs)
                );
                cb();
            }

            if (
                this.getWorkspaceConfigFiles().findIndex(
                    (file) => vscode.workspace.asRelativePath(e.uri.path) === vscode.workspace.asRelativePath(file.path)
                ) > -1
            ) {
                this.workspaceConfigs = {};
                this.getWorkspaceConfigFiles().forEach((file, index) => {
                    const promise = vscode.workspace.fs.readFile(file);
                    promises.push(promise);
                    promise.then((value) => {
                        let workspaceConfigs = Extension.extensionContext.workspaceState.get("configs");
                        if (!workspaceConfigs) {
                            workspaceConfigs = {};
                        }

                        let fileConfigs = {} as ConfigsInterface;
                        try {
                            const errors: jsonc.ParseError[] = [];
                            fileConfigs = jsonc.parse(value.toString(), errors);
                            if (errors.length > 0) {
                                Extension.showErrorMessage("Can't parse config file. Check config syntax.");
                                return;
                            }
                        } catch (error) {
                            Extension.showErrorMessage("Can't parse config file. Check config syntax.");
                            return;
                        }

                        const configs = Object.assign({}, this.defaultConfigs, fileConfigs, workspaceConfigs);
                        if (fileConfigs.ignore) {
                            configs.ignore = fileConfigs.ignore;
                        }
                        if (index === 0) {
                            this.configs = configs;
                        }
                        const workspaceFolder = vscode.workspace.getWorkspaceFolder(file);
                        if (workspaceFolder) {
                            this.workspaceConfigs[workspaceFolder.uri.path] = configs;
                        }

                        Extension.appendLineToOutputChannel(
                            "[INFO] The config file is loaded: " + JSON.stringify(this.configs)
                        );
                    });
                });

                Promise.all(promises).then(() => {
                    cb();
                });
            }
        });
        Extension.extensionContext.subscriptions.push(disposables);
    }
}
