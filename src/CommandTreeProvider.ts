import * as vscode from 'vscode';

export class DbosCommandTreeProvider implements vscode.TreeDataProvider<DbosCommandItem> {
    
    getTreeItem(element: DbosCommandItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: DbosCommandItem): Thenable<DbosCommandItem[]> {
        if (element) {
            return Promise.resolve([]);
        } else {
            return Promise.resolve([
                new DbosCommandItem('Connect to Device', 'dbos.connect', new vscode.ThemeIcon('plug')),
                new DbosCommandItem('Open Bot Files', 'dbos.openWorkspace', new vscode.ThemeIcon('folder-opened')),
                new DbosCommandItem('Start Dodo Bot', 'dbos.startBot', new vscode.ThemeIcon('play')),
                new DbosCommandItem('Stop Dodo Bot', 'dbos.stopBot', new vscode.ThemeIcon('stop')),
                new DbosCommandItem('Restart Dodo Bot', 'dbos.restartBot', new vscode.ThemeIcon('refresh')),
                new DbosCommandItem('View Logs', 'dbos.viewLogs', new vscode.ThemeIcon('output')),
                new DbosCommandItem('Reboot Hardware', 'dbos.reboot', new vscode.ThemeIcon('power'))
            ]);
        }
    }
}

export class DbosCommandItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly commandId: string,
        public readonly icon: vscode.ThemeIcon
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = icon;
        this.command = {
            command: commandId,
            title: label
        };
    }
}
