import * as vscode from 'vscode';
import { Client, SFTPWrapper } from 'ssh2';
import * as path from 'path';

export class SshFileSystemProvider implements vscode.FileSystemProvider {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    private sftp: SFTPWrapper | null = null;

    constructor(private client: Client) {}

    public async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.client.sftp((err, sftp) => {
                if (err) {
                    reject(err);
                } else {
                    this.sftp = sftp;
                    resolve();
                }
            });
        });
    }

    watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
        // Simple watch, not fully implemented for remote SSH due to complexity
        return new vscode.Disposable(() => { });
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        if (!this.sftp) throw vscode.FileSystemError.Unavailable('SFTP not connected');
        
        return new Promise((resolve, reject) => {
            this.sftp!.stat(uri.path, (err, stats) => {
                if (err) {
                    if ((err as any).code === 2) { // ENOENT
                        reject(vscode.FileSystemError.FileNotFound(uri));
                    } else {
                        reject(err);
                    }
                    return;
                }
                
                let type = vscode.FileType.Unknown;
                if (stats.isDirectory()) type = vscode.FileType.Directory;
                else if (stats.isFile()) type = vscode.FileType.File;
                else if (stats.isSymbolicLink()) type = vscode.FileType.SymbolicLink;

                resolve({
                    type: type,
                    ctime: stats.mtime * 1000,
                    mtime: stats.mtime * 1000,
                    size: stats.size
                });
            });
        });
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        if (!this.sftp) throw vscode.FileSystemError.Unavailable('SFTP not connected');

        return new Promise((resolve, reject) => {
            this.sftp!.readdir(uri.path, (err, list) => {
                if (err) {
                    reject(err);
                    return;
                }
                const result: [string, vscode.FileType][] = list.map(item => {
                    let type = vscode.FileType.Unknown;
                    if (item.attrs.isDirectory()) type = vscode.FileType.Directory;
                    else if (item.attrs.isFile()) type = vscode.FileType.File;
                    else if (item.attrs.isSymbolicLink()) type = vscode.FileType.SymbolicLink;
                    return [item.filename, type];
                });
                resolve(result);
            });
        });
    }

    async createDirectory(uri: vscode.Uri): Promise<void> {
        if (!this.sftp) throw vscode.FileSystemError.Unavailable('SFTP not connected');
        return new Promise((resolve, reject) => {
            this.sftp!.mkdir(uri.path, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        if (!this.sftp) throw vscode.FileSystemError.Unavailable('SFTP not connected');
        return new Promise((resolve, reject) => {
            this.sftp!.readFile(uri.path, (err, data) => {
                if (err) {
                    if ((err as any).code === 2) reject(vscode.FileSystemError.FileNotFound(uri));
                    else reject(err);
                    return;
                }
                resolve(new Uint8Array(data));
            });
        });
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Promise<void> {
        if (!this.sftp) throw vscode.FileSystemError.Unavailable('SFTP not connected');
        return new Promise((resolve, reject) => {
            const buffer = Buffer.from(content);
            this.sftp!.writeFile(uri.path, buffer, (err) => {
                if (err) reject(err);
                else {
                    this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
                    resolve();
                }
            });
        });
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean; }): Promise<void> {
        if (!this.sftp) throw vscode.FileSystemError.Unavailable('SFTP not connected');
        
        // Very basic delete - doesn't handle recursive fully yet
        return new Promise((resolve, reject) => {
            this.sftp!.stat(uri.path, (err, stats) => {
                if (err) return reject(err);
                
                if (stats.isDirectory()) {
                    this.sftp!.rmdir(uri.path, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                } else {
                    this.sftp!.unlink(uri.path, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                }
            });
        });
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): Promise<void> {
        if (!this.sftp) throw vscode.FileSystemError.Unavailable('SFTP not connected');
        return new Promise((resolve, reject) => {
            this.sftp!.rename(oldUri.path, newUri.path, (err) => {
                if (err) reject(err);
                else {
                    this._emitter.fire([
                        { type: vscode.FileChangeType.Deleted, uri: oldUri },
                        { type: vscode.FileChangeType.Created, uri: newUri }
                    ]);
                    resolve();
                }
            });
        });
    }
}
