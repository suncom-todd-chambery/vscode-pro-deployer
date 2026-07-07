import * as fs from "fs";
import * as path from "path";
import type { Client as SSH2Client, SFTPWrapper as SSH2SFTPWrapper } from "ssh2";
import * as vscode from "vscode";
import { Queue } from "../Queue";
import { Configs } from "../configs";
import { Extension } from "../extension";
import { QueueTask, TargetInterface, TargetOptionsInterface } from "./Interfaces";
import { Target } from "./Target";
import { Targets } from "./Targets";
import EventEmitter = require("events");

const nodeUtil = require("util") as {
    isDate?: (value: unknown) => boolean;
};

if (typeof nodeUtil.isDate !== "function") {
    nodeUtil.isDate = (value: unknown): boolean => value instanceof Date;
}

const ssh2: typeof import("ssh2") = require("ssh2");

export class SFTP extends Target implements TargetInterface {
    private client: SSH2Client | null = null;
    private sftp: SSH2SFTPWrapper | null = null;
    private name: string;
    private isConnected: boolean = false;
    private isConnecting: boolean = false;
    private queue: Queue<QueueTask> = new Queue<QueueTask>();
    private creatingDirectories: Map<string, Promise<string>> = new Map([]);
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 3;
    private reconnectDelay: number = 2000;
    private lastUploadTime: number = 0;
    private idleCheckInterval: NodeJS.Timer | null = null;
    private uploadTimeouts: Map<string, NodeJS.Timeout> = new Map();
    private readonly UPLOAD_TIMEOUT = 60 * 1000; // 60 seconds
    private readonly IDLE_TIMEOUT = 40 * 60 * 1000; // 40 minutes
    private readonly IDLE_CHECK_FREQUENCY = 60 * 1000; // 1 minute

    constructor(private options: TargetOptionsInterface, workspaceFolder: vscode.WorkspaceFolder) {
        super(workspaceFolder);
        this.setMaxListeners(10000);

        this.name = options.name;

        this.queue.concurrency = Configs.getWorkspaceConfigs(workspaceFolder.uri).concurrency ?? 5;
        this.queue.autostart = true;
        this.queue.setMaxListeners(10000);



        Extension.appendLineToOutputChannel(
            "[INFO][FTP] target is created. Workspace: " + this.getWorkspaceFolder().name + ". Name: " + this.name
        );
    }

    connect(cb: Function, errorCb: Function | undefined = undefined): void {
        if (this.isConnected) {
            cb();
            return;
        }

        if (this.isConnecting === true) {
            return;
        }
        this.isConnecting = true;

        this.createClient();

        this.once("ready", () => {
            cb();
            this.lastUploadTime = Date.now();
            this.startIdleCheck();
            Extension.appendLineToOutputChannel("[INFO][SFTP] Connected successfully to: " + this.options.host);
        });
        this.once("error", (error) => {
            Extension.showErrorMessage("Can't connect to " + this.getName() + ": " + error);
            if (errorCb) {
                errorCb(error);
            }
        });

        if (this.client) {
            this.client.once("ready", () => {
                this.client?.sftp((err: any, sftpClient: SSH2SFTPWrapper) => {
                    if (!err) {
                        this.sftp = sftpClient;

                        this.isConnected = true;
                        this.isConnecting = false;
                        this.emit("ready", this);
                    } else {
                        Extension.appendLineToOutputChannel("[ERROR][SFTP] Can't convert ssh2 to sftp");
                    }
                });
            });
            this.client.once("error", (error: any) => {
                this.isConnected = false;
                this.isConnecting = false;
                this.emit("error", error);
            });

            if (!this.options.port) {
                this.options.port = 22;
            }
            if (this.options.dir[this.options.dir.length - 1] !== "/") {
                this.options.dir += "/";
            }

            let privateKey = undefined;
            try {
                privateKey = this.options.privateKey ? fs.readFileSync(this.options.privateKey) : undefined;
            } catch (err) {
                Extension.showErrorMessage("[SFTP] Can't read private key file: " + this.options.privateKey);
                return;
            }

            Extension.appendLineToOutputChannel(
                "[INFO][SFTP] Connecting to: " + this.options.host + ":" + this.options.port
            );
            this.client.connect({
                host: this.options.host,
                port: this.options.port,
                username: this.options.user,
                password: this.options.password,
                privateKey: privateKey,
                passphrase: this.options.passphrase,
            });
        }
    }
    upload(uri: vscode.Uri, sourceUri?: vscode.Uri, attempts: number = 1): Promise<vscode.Uri> {
        const relativePath = Targets.getRelativePath(
            this.options,
            uri,
            Configs.getWorkspaceConfigs(uri).ignoreSourceParentPaths ? sourceUri : undefined
        );
        return new Promise<vscode.Uri>((resolve, reject) => {
            if (!this.isConnected) {
                reject("Not connected");
                return;
            }

            const job = <QueueTask>((cb) => {
                if (!this.sftp) {
                    Extension.appendLineToOutputChannel("[ERROR][SFTP] SFTP client missing");
                    cb("SFTP client missing");
                    reject("SFTP client missing");
                    return;
                }

                let uploadReadStream: fs.ReadStream | null = null;
                let uploadWriteStream: any = null;
                let isTimeout = false;
                this.clearUploadTimeout(relativePath);
                const timer = setTimeout(() => {
                    // Ignore stale timeout handlers from older attempts for the same file.
                    if (this.uploadTimeouts.get(relativePath) !== timer) {
                        return;
                    }
                    this.uploadTimeouts.delete(relativePath);
                    isTimeout = true;
                    if (uploadReadStream) {
                        uploadReadStream.destroy();
                    }
                    if (uploadWriteStream && typeof uploadWriteStream.destroy === "function") {
                        uploadWriteStream.destroy();
                    }
                    Extension.appendLineToOutputChannel(
                        `[WARNING][SFTP] Upload stalled (${this.UPLOAD_TIMEOUT / 1000}s). Retrying... (Attempt ${attempts})`
                    );

                    if (attempts < 3) {
                        this.queue.stop();
                        this.destroy(true);
                        Extension.appendLineToOutputChannel(
                            `[INFO][SFTP] Reconnect requested for upload retry (next attempt ${attempts + 1}).`
                        );

                        this.connect(() => {
                            Extension.appendLineToOutputChannel(
                                `[INFO][SFTP] Reconnected. Re-queue upload for: ${relativePath} (attempt ${attempts + 1}).`
                            );
                            this.queue.start();
                            this.upload(uri, sourceUri, attempts + 1).then(resolve, reject);
                        }, (err: any) => {
                            Extension.appendLineToOutputChannel(
                                `[ERROR][SFTP] Reconnect failed during upload retry: ${err}`
                            );
                            this.queue.start();
                            reject("Connection failed during retry: " + err);
                        });
                        cb();
                    } else {
                        Extension.appendLineToOutputChannel(`[ERROR][SFTP] Upload timeout after 3 attempts.`);
                        reject("Upload timeout");
                        cb("Upload timeout");
                    }
                }, this.UPLOAD_TIMEOUT);
                this.uploadTimeouts.set(relativePath, timer);

                const remoteRelativeDir = path.dirname(relativePath);
                const mkdirPromise = remoteRelativeDir !== "."
                    ? this.mkdir(this.options.dir + remoteRelativeDir)
                    : Promise.resolve("");

                mkdirPromise.then(() => {
                    if (isTimeout) { return; }
                    Extension.appendLineToOutputChannel("[INFO][SFTP] Start uploading file: " + relativePath);
                    if (!this.sftp) {
                        this.clearUploadTimeout(relativePath);
                        cb("SFTP client missing");
                        reject("SFTP client missing");
                        return;
                    }

                    let isFinished = false;
                    const finishWithError = (reason: any) => {
                        if (isFinished || isTimeout) {
                            return;
                        }
                        isFinished = true;
                        this.clearUploadTimeout(relativePath);
                        Extension.appendLineToOutputChannel(
                            "[ERROR][SFTP] Can't upload file: " + uri.path + ". Error: " + reason
                        );
                        cb(reason);
                        reject(reason);
                    };

                    uploadReadStream = fs.createReadStream(uri.fsPath);
                    uploadWriteStream = this.sftp.createWriteStream(this.options.dir + relativePath);

                    uploadReadStream.once("error", finishWithError);
                    uploadWriteStream.once("error", finishWithError);
                    uploadWriteStream.once("close", () => {
                        if (isFinished || isTimeout) {
                            return;
                        }
                        isFinished = true;
                        this.clearUploadTimeout(relativePath);
                        Extension.appendLineToOutputChannel(
                            "[INFO][SFTP] File: '" +
                            relativePath +
                            "' is uploaded to: '" +
                            this.options.dir +
                            relativePath +
                            "'"
                        );
                        this.lastUploadTime = Date.now();
                        cb();
                        resolve(uri);
                    });

                    uploadReadStream.pipe(uploadWriteStream);
                }, (reason: Error) => {
                    if (isTimeout) { return; }
                    this.clearUploadTimeout(relativePath);
                    Extension.appendLineToOutputChannel(
                        "[ERROR][SFTP] Can't create remote dir for: " + relativePath + ". Error: " + reason
                    );
                    cb(reason);
                    reject(reason);
                });
            });
            job.uri = uri;
            job.isFile = true;
            job.action = "upload";
            this.queue.push(job);
        });
    }
    delete(uri: vscode.Uri): Promise<vscode.Uri> {
        const relativePath = Targets.getRelativePath(this.options, uri);

        return new Promise<vscode.Uri>((resolve, reject) => {
            if (!this.isConnected) {
                reject("Not connected");
                return;
            }

            const job = <QueueTask>((cb) => {
                if (!this.sftp) {
                    Extension.appendLineToOutputChannel("[ERROR][SFTP] SFTP client missing");
                    return;
                }
                this.sftp.unlink(this.options.dir + relativePath, (err: any) => {
                    if (err) {
                        if (err.code === 2) {
                            Extension.appendLineToOutputChannel(
                                "[INFO][SFTP] File deleted (No such file): '" + this.options.dir + relativePath
                            );
                            cb();
                            resolve(uri);
                            return;
                        }
                        cb(err);
                        reject(err);
                        return;
                    }
                    Extension.appendLineToOutputChannel("[INFO][SFTP] File deleted: '" + relativePath);
                    cb();
                    resolve(uri);
                });
            });
            job.uri = uri;
            job.isFile = true;
            job.action = "delete";
            this.queue.push(job);
        });
    }
    download(uri: vscode.Uri, destination?: vscode.Uri): Promise<vscode.Uri> {
        const relativePath = Targets.getRelativePath(this.options, uri);

        if (destination === undefined) {
            destination = uri;
        }

        return new Promise<vscode.Uri>((resolve, reject) => {
            if (!this.isConnected) {
                reject("Not connected");
                return;
            }

            const job = <QueueTask>((cb) => {
                if (!this.sftp) {
                    Extension.appendLineToOutputChannel("[ERROR][SFTP] SFTP client missing");
                    return;
                }
                Extension.appendLineToOutputChannel("[INFO][SFTP] Read file: '" + relativePath);
                this.sftp.readFile(this.options.dir + relativePath, {}, (err: any, handle: Buffer) => {
                    if (err) {
                        cb(err);
                        reject(err);
                        return;
                    }
                    vscode.workspace.fs.writeFile(destination!, new Uint8Array(handle)).then(
                        () => {
                            // Check if the file is unsaved in the editor
                            const unsaveFile = vscode.workspace.textDocuments.find(
                                (doc) => doc.uri.fsPath === destination?.fsPath
                            );
                            if (unsaveFile && unsaveFile.isDirty) {
                                const edit = new vscode.WorkspaceEdit();
                                const fullRange = new vscode.Range(0, 0, unsaveFile.lineCount, 0); // Range covering the entire document
                                edit.replace(uri, fullRange, handle.toString());
                                vscode.workspace.applyEdit(edit);
                                unsaveFile.save();
                            }
                            Extension.appendLineToOutputChannel("[INFO][SFTP] File downloaded: '" + relativePath);
                            cb();
                            resolve(uri);
                        },
                        (reason) => {
                            cb(reason);
                            reject(reason);
                        }
                    );
                });
            });
            job.uri = uri;
            job.isFile = true;
            job.action = "download";
            this.queue.push(job);
        });
    }
    downloadDir(uri: vscode.Uri): Promise<vscode.Uri> {
        var relativePath = Targets.getRelativePath(this.options, uri);
        if (relativePath === Extension.getActiveWorkspaceFolder()?.uri.path) {
            relativePath = "";
        }

        return new Promise<vscode.Uri>((resolve, reject) => {
            if (!this.isConnected) {
                reject("Not connected");
                return;
            }
            const job = <QueueTask>((cb) => {
                const readDir = (dir: string): Promise<any> => {
                    return new Promise<any>((readDirResolve, readDirReject) => {
                        Extension.appendLineToOutputChannel("[INFO][SFTP] Start read dir: '" + dir);
                        this.sftp?.readdir(this.options.dir + dir, (err: any, list: any[]) => {
                            if (err) {
                                Extension.appendLineToOutputChannel(
                                    "[ERROR][SFTP] Can't read dir: '" + dir + "'. Error: " + err
                                );
                                cb(err);
                                readDirReject(err);
                                return;
                            }
                            Extension.appendLineToOutputChannel("[INFO][SFTP] Dir files: " + list.length);
                            let statPromises: Promise<vscode.Uri>[] = [];

                            list.forEach((item: any) => {
                                statPromises.push(
                                    new Promise<vscode.Uri>((statResolve, statReject) => {
                                        const file = vscode.Uri.file(
                                            Extension.getActiveWorkspaceFolder()?.uri.path +
                                            "/" +
                                            dir +
                                            "/" +
                                            item.filename
                                        );
                                        this.sftp?.stat(this.options.dir + dir + "/" + item.filename, (err: any, stats: any) => {
                                            if (err) {
                                                Extension.appendLineToOutputChannel(
                                                    "[ERROR][SFTP] Can't get stat for: '" +
                                                    this.options.dir +
                                                    dir +
                                                    "/" +
                                                    item.filename +
                                                    "'. Error: " +
                                                    err
                                                );
                                                statReject(err);
                                                return;
                                            }

                                            let downloadOrReadPromise: Promise<any> | undefined = undefined;

                                            if (stats.isFile()) {
                                                downloadOrReadPromise = this.download(file);
                                            } else if (stats.isDirectory()) {
                                                downloadOrReadPromise = readDir(dir + "/" + item.filename);
                                            }
                                            if (!downloadOrReadPromise) {
                                                statReject("Unknown file type");
                                                return;
                                            }
                                            downloadOrReadPromise.finally(() => {
                                                statResolve(file);
                                            });
                                        });
                                    })
                                );
                            });

                            Promise.all(statPromises).finally(() => {
                                cb();
                                readDirResolve(list);
                            });
                        });
                    });
                };

                readDir(relativePath).finally(() => {
                    resolve(uri);
                    Extension.appendLineToOutputChannel("[INFO][SFTP] Dir downloaded: '" + relativePath);
                });
            });
            job.uri = uri;
            job.isFile = true;
            job.action = "downloadDir";
            this.queue.push(job);
        });
    }
    deleteDir(uri: vscode.Uri): Promise<vscode.Uri> {
        const relativePath = Targets.getRelativePath(this.options, uri);

        return new Promise<vscode.Uri>((resolve, reject) => {
            if (!this.isConnected) {
                reject("Not connected");
                return;
            }

            const job = <QueueTask>((cb) => {
                const dir = this.options.dir + relativePath;
                if (dir === "/") {
                    cb("Can't delete '/' (root dir)");
                    reject("Can't delete '/' (root dir)");
                    return;
                }
                Extension.appendLineToOutputChannel("[INFO][SFTP] Start deleting dir: " + dir);
                if (!this.client) {
                    Extension.appendLineToOutputChannel("[ERROR][SFTP] SFTP client missing");
                    reject("SFTP client missing");
                    return;
                }
                this.client.exec("rm -rf " + dir, (err: any, channel: any) => {
                    if (err) {
                        cb(err.message);
                        reject(err.message);
                        return;
                    }
                    cb();
                    resolve(uri);
                });
            });
            job.uri = uri;
            job.action = "delete";
            job.isFile = false;
            this.queue.push(job);
        });
    }
    mkdir(dir: string): Promise<string> {
        if (this.creatingDirectories.has(dir)) {
            const promise = this.creatingDirectories.get(dir);
            if (promise) {
                return promise;
            }
        }
        const promise = new Promise<string>((resolve, reject) => {
            if (!this.isConnected) {
                reject("Not connected");
                return;
            }
            if (!this.sftp) {
                Extension.appendLineToOutputChannel("[ERROR][SFTP] SFTP client missing");
                reject("SFTP client missing");
                return;
            }
            Extension.appendLineToOutputChannel("[INFO][SFTP] Try to create dir: " + dir);
            this.sftp.mkdir(dir, (err: any) => {
                if (err) {
                    if (err.code === 2) {
                        // No such file or directory
                        this.mkdir(path.dirname(dir)).then(
                            () => {
                                this.sftp?.mkdir(dir, (err: any) => {
                                    if (err) {
                                        this.sftp?.exists(dir, (response: boolean) => {
                                            if (!response) {
                                                reject(err);
                                                return;
                                            }
                                            resolve("");
                                        });
                                        return;
                                    }
                                    resolve("");
                                });
                            },
                            (err) => {
                                this.sftp?.exists(dir, (response: boolean) => {
                                    if (!response) {
                                        reject(err);
                                        return;
                                    }
                                    resolve("");
                                });
                            }
                        );
                        return;
                    }
                    this.sftp?.exists(dir, (response: boolean) => {
                        if (!response) {
                            reject(err);
                            return;
                        }
                        resolve("");
                    });
                    return;
                }
                resolve("");
            });
        });
        promise.finally(() => {
            this.creatingDirectories.delete(dir);
        });
        this.creatingDirectories.set(dir, promise);

        return promise;
    }

    getName(): string {
        return this.name;
    }

    getQueue(): Queue<QueueTask> {
        return this.queue;
    }

    destroy(keepQueue: boolean = false) {
        if (this.idleCheckInterval) {
            clearInterval(this.idleCheckInterval);
            this.idleCheckInterval = null;
        }
        this.uploadTimeouts.forEach((timer) => {
            clearTimeout(timer);
        });
        this.uploadTimeouts.clear();
        this.isConnected = false;
        this.isConnecting = false;
        this.sftp = null;
        if (this.client) {
            this.client.destroy();
            this.client = null;
        }
        if (!keepQueue) {
            this.queue.end();
        }
        Extension.appendLineToOutputChannel("[INFO][SFTP] The connection is destroyed");
    }

    private startIdleCheck() {
        if (this.idleCheckInterval) {
            clearInterval(this.idleCheckInterval);
        }
        this.idleCheckInterval = setInterval(() => {
            if (Date.now() - this.lastUploadTime > this.IDLE_TIMEOUT) {
                Extension.appendLineToOutputChannel("[INFO][SFTP] Idle timeout detected. Reconnecting...");
                this.reconnect();
            }
        }, this.IDLE_CHECK_FREQUENCY);
    }

    private createClient() {
        if (this.client) {
            try {
                this.client.removeAllListeners();
                this.client.destroy();
            } catch (err) {
                // Ignore
            }
        }
        this.client = new ssh2.Client();
        this.client.setMaxListeners(10000);
        this.client.on("error", (error: any) => {
            this.handleConnectionError(error);
        });
        this.client.on("close", () => {
            this.isConnected = false;
            this.isConnecting = false;
            Extension.appendLineToOutputChannel("[INFO][SFTP] The connection is closed");
        });
        this.client.on("end", () => {
            this.isConnected = false;
            this.isConnecting = false;
            Extension.appendLineToOutputChannel("[INFO][SFTP] The connection is ended");
        });
    }

    private isTimeoutError(error: any): boolean {
        const errorStr = error.toString().toLowerCase();
        return (
            errorStr.includes("timeout") ||
            errorStr.includes("etimedout") ||
            errorStr.includes("econnreset") ||
            errorStr.includes("econnrefused") ||
            error.code === "ETIMEDOUT" ||
            error.code === "ECONNRESET" ||
            error.code === "ECONNREFUSED" ||
            error.level === "client-timeout" ||
            error.level === "client-socket"
        );
    }

    private handleConnectionError(error: any): void {
        const config = Configs.getWorkspaceConfigs(this.getWorkspaceFolder().uri);
        const shouldReconnect = config.reconnectOnTimeout ?? true;
        const isTimeout = this.isTimeoutError(error);

        if (isTimeout && shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            Extension.appendLineToOutputChannel(
                `[WARNING][SFTP] Connection timeout/error detected. Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
            );

            setTimeout(() => {
                this.reconnect();
            }, this.reconnectDelay);
        } else {
            if (isTimeout && shouldReconnect && this.reconnectAttempts >= this.maxReconnectAttempts) {
                Extension.showErrorMessage(
                    `[ERROR][SFTP] Failed to reconnect after ${this.maxReconnectAttempts} attempts: ` + error
                );
                Extension.setConnectionError(true);
            } else {
                Extension.appendLineToOutputChannel("[ERROR][SFTP] " + error);
            }
            this.reconnectAttempts = 0;
        }
    }

    private reconnect(): void {
        Extension.appendLineToOutputChannel("[INFO][SFTP] Reconnecting...");
        this.destroy(true);
        this.isConnected = false;
        this.isConnecting = false;
        this.sftp = null;

        // Connect will handle client recreation
        this.connect(
            () => {
                Extension.appendLineToOutputChannel("[INFO][SFTP] Successfully reconnected");
                Extension.setConnectionError(false);
                this.reconnectAttempts = 0;
            },
            (error: any) => {
                Extension.appendLineToOutputChannel("[ERROR][SFTP] Reconnection failed: " + error);
            }
        );
    }

    private clearUploadTimeout(relativePath: string): void {
        const existingTimer = this.uploadTimeouts.get(relativePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.uploadTimeouts.delete(relativePath);
        }
    }
}
