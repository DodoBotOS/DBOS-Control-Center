import * as vscode from 'vscode';
import { Client } from 'ssh2';
import { SshFileSystemProvider } from './SshFileSystemProvider';
import { DbosCommandTreeProvider } from './CommandTreeProvider';

let sshClient: Client | null = null;
let fileSystemProvider: SshFileSystemProvider | null = null;
let connectionConfig = {
    host: '192.168.3.136', // Default or prompt user
    port: 22,
    username: 'root',
    password: '' // Need to prompt
};

export async function activate(context: vscode.ExtensionContext) {
    console.log('DBOS Control Center is now active!');

    // Register GUI Tree Provider
    const treeProvider = new DbosCommandTreeProvider();
    vscode.window.registerTreeDataProvider('dbosCommands', treeProvider);

    // Auto-reconnect if we have saved credentials and the workspace is open
    const savedHost = context.globalState.get<string>('dbos.host');
    if (savedHost) {
        const savedPassword = await context.secrets.get('dbos.password');
        if (savedPassword) {
            connectionConfig.host = savedHost;
            connectionConfig.password = savedPassword;
            // Check if dbos folder is open
            if (vscode.workspace.workspaceFolders?.some(f => f.uri.scheme === 'dbos')) {
                await connectToDbos(context, true);
            }
        }
    }

    let connectCmd = vscode.commands.registerCommand('dbos.connect', async () => {
        const host = await vscode.window.showInputBox({ prompt: 'Enter DBOS IP Address', value: connectionConfig.host });
        if (!host) return;
        const password = await vscode.window.showInputBox({ prompt: 'Enter SSH Password for root', password: true });
        if (!password) return;

        connectionConfig.host = host;
        connectionConfig.password = password;

        await context.globalState.update('dbos.host', host);
        await context.secrets.store('dbos.password', password);

        await connectToDbos(context, false);
    });

    let openWorkspaceCmd = vscode.commands.registerCommand('dbos.openWorkspace', () => {
        if (!fileSystemProvider) {
            vscode.window.showErrorMessage('Please connect to DBOS first.');
            return;
        }
        vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0, null, {
            uri: vscode.Uri.parse('dbos:/root/'),
            name: "Dodo Bot OS (/root)"
        });
    });

    let startBotCmd = vscode.commands.registerCommand('dbos.startBot', () => {
        executeSshCommand('systemctl start dodobot', 'Dodo Bot Started!');
    });

    let stopBotCmd = vscode.commands.registerCommand('dbos.stopBot', () => {
        executeSshCommand('systemctl stop dodobot', 'Dodo Bot Stopped!');
    });

    let restartBotCmd = vscode.commands.registerCommand('dbos.restartBot', () => {
        executeSshCommand('systemctl restart dodobot', 'Dodo Bot Restarted!');
    });

    let viewLogsCmd = vscode.commands.registerCommand('dbos.viewLogs', () => {
        if (!sshClient) {
            vscode.window.showErrorMessage('Please connect to DBOS first.');
            return;
        }
        
        const outputChannel = vscode.window.createOutputChannel("Dodo Bot Logs");
        outputChannel.show();
        
        sshClient.exec('journalctl -u dodobot -f', (err, stream) => {
            if (err) {
                vscode.window.showErrorMessage('Failed to fetch logs: ' + err.message);
                return;
            }
            stream.on('data', (data: any) => {
                outputChannel.append(data.toString());
            }).stderr.on('data', (data: any) => {
                outputChannel.append('ERROR: ' + data.toString());
            });
        });
    });

    let rebootCmd = vscode.commands.registerCommand('dbos.reboot', async () => {
        const confirm = await vscode.window.showWarningMessage('Are you sure you want to reboot the hardware?', 'Yes', 'No');
        if (confirm === 'Yes') {
            executeSshCommand('reboot', 'Hardware is rebooting...');
        }
    });

    let openTerminalCmd = vscode.commands.registerCommand('dbos.openTerminal', () => {
        if (!connectionConfig.host) {
            vscode.window.showErrorMessage('Please connect to DBOS first.');
            return;
        }
        const term = vscode.window.createTerminal('DBOS SSH');
        term.show();
        term.sendText(`ssh root@${connectionConfig.host}`);
    });

    let downloadBackupCmd = vscode.commands.registerCommand('dbos.downloadBackup', async () => {
        if (!sshClient) {
            vscode.window.showErrorMessage('Please connect to DBOS first.');
            return;
        }

        const option = await vscode.window.showQuickPick([
            'Download backup with node_modules',
            'Download backup without node_modules'
        ], { placeHolder: 'Select backup type' });

        if (!option) return;

        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('dbos_backup.tar.gz'),
            filters: { 'Archives': ['tar.gz'] }
        });

        if (!uri) return;

        const exclude = option === 'Download backup without node_modules' ? "--exclude='./node_modules' " : "";
        const tarCmd = `tar -czf /tmp/dbos_backup.tar.gz ${exclude}-C /root .`;

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Creating and downloading backup...",
            cancellable: false
        }, async (progress) => {
            return new Promise<void>((resolve, reject) => {
                sshClient!.exec(tarCmd, (err, stream) => {
                    if (err) {
                        vscode.window.showErrorMessage('Backup failed: ' + err.message);
                        return reject(err);
                    }
                    stream.on('close', (code: any) => {
                        if (code !== 0) {
                            vscode.window.showErrorMessage('Failed to create backup on device.');
                            return reject(new Error('tar failed'));
                        }
                        
                        sshClient!.sftp((err, sftp) => {
                            if (err) {
                                vscode.window.showErrorMessage('SFTP failed: ' + err.message);
                                return reject(err);
                            }
                            sftp.fastGet('/tmp/dbos_backup.tar.gz', uri.fsPath, (err) => {
                                if (err) {
                                    vscode.window.showErrorMessage('Download failed: ' + err.message);
                                    return reject(err);
                                }
                                vscode.window.showInformationMessage('Backup downloaded to ' + uri.fsPath);
                                sshClient!.exec('rm /tmp/dbos_backup.tar.gz', () => {});
                                resolve();
                            });
                        });
                    }).stderr.on('data', (data: any) => console.error(data.toString()));
                });
            });
        });
    });

    context.subscriptions.push(connectCmd, openWorkspaceCmd, startBotCmd, stopBotCmd, restartBotCmd, viewLogsCmd, rebootCmd, openTerminalCmd, downloadBackupCmd);
}

async function connectToDbos(context: vscode.ExtensionContext, silent: boolean): Promise<void> {
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Connecting to DBOS...",
        cancellable: false
    }, async (progress) => {
        return new Promise<void>((resolve, reject) => {
            sshClient = new Client();
            sshClient.on('ready', async () => {
                if (!silent) vscode.window.showInformationMessage('Connected to DBOS successfully!');
                
                // Initialize File System Provider
                fileSystemProvider = new SshFileSystemProvider(sshClient!);
                await fileSystemProvider.connect();
                context.subscriptions.push(vscode.workspace.registerFileSystemProvider('dbos', fileSystemProvider, { isCaseSensitive: true }));
                
                if (!silent) vscode.window.showInformationMessage('DBOS File System is ready! You can now open files.');
                resolve();
            }).on('error', (err) => {
                if (!silent) vscode.window.showErrorMessage('Connection failed: ' + err.message);
                reject(err);
            }).connect(connectionConfig);
        });
    });
}


function executeSshCommand(command: string, successMsg: string) {
    if (!sshClient) {
        vscode.window.showErrorMessage('Please connect to DBOS first.');
        return;
    }
    sshClient.exec(command, (err, stream) => {
        if (err) {
            vscode.window.showErrorMessage('Command failed: ' + err.message);
            return;
        }
        stream.on('close', (code: any, signal: any) => {
            if (code === 0) {
                vscode.window.showInformationMessage(successMsg);
            } else {
                vscode.window.showErrorMessage(`Command failed with exit code ${code}`);
            }
        }).stderr.on('data', (data: any) => {
            console.error('STDERR: ' + data);
        });
    });
}

export function deactivate() {
    if (sshClient) {
        sshClient.end();
    }
}
