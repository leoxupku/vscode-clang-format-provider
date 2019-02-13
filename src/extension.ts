import * as vscode from 'vscode';
import cp = require('child_process');
import path = require('path');
import {MODES} from './clangMode';
import sax = require('sax');
import fs = require('fs');

export let outputChannel = vscode.window.createOutputChannel('Clang-Format');

export class ClangDocumentFormattingEditProvider implements vscode.DocumentFormattingEditProvider {

  // interface of DocumentFormattingEditProvider
  public provideDocumentFormattingEdits(document: vscode.TextDocument, options: vscode.FormattingOptions, token: vscode.CancellationToken): Thenable<vscode.TextEdit[]> {
    return this.doFormatDocument(document, options, token);
  }

  private getEdits(document: vscode.TextDocument, xml: string, codeContent: string): Thenable<vscode.TextEdit[]> {
    return new Promise((resolve, reject) => {
      let options = {
        trim: false,
        normalize: false,
        loose: true
      };
      let parser = sax.parser(true, options);

      let edits: vscode.TextEdit[] = [];
      let currentEdit: { length: number, offset: number, text: string };

      let codeBuffer = new Buffer(codeContent);
      // encoding position cache
      let codeByteOffsetCache = {
        byte: 0,
        offset: 0
      };
      let byteToOffset = function(editInfo: { length: number, offset: number }) {
        let offset = editInfo.offset;
        let length = editInfo.length;

        if (offset >= codeByteOffsetCache.byte) {
          editInfo.offset = codeByteOffsetCache.offset + codeBuffer.slice(codeByteOffsetCache.byte, offset).toString('utf8').length;
          codeByteOffsetCache.byte = offset;
          codeByteOffsetCache.offset = editInfo.offset;
        } else {
          editInfo.offset = codeBuffer.slice(0, offset).toString('utf8').length;
          codeByteOffsetCache.byte = offset;
          codeByteOffsetCache.offset = editInfo.offset;
        }

        editInfo.length = codeBuffer.slice(offset, offset + length).toString('utf8').length;

        return editInfo;
      };

      parser.onerror = (err) => {
        reject(err.message);
      };

      parser.onopentag = (tag) => {
        if (currentEdit) {
          reject('Malformed output');
        }

        switch (tag.name) {
        case 'replacements':
          return;

        case 'replacement':
          currentEdit = {
            length: parseInt(tag.attributes['length'].toString()),
            offset: parseInt(tag.attributes['offset'].toString()),
            text: ''
          };
          byteToOffset(currentEdit);
          break;

        default:
          reject(`Unexpected tag ${tag.name}`);
        }
      };

      parser.ontext = (text) => {
        if (!currentEdit) { return; }

        currentEdit.text = text;
      };

      parser.onclosetag = (tagName) => {
        if (!currentEdit) { return; }

        let start = document.positionAt(currentEdit.offset);
        let end = document.positionAt(currentEdit.offset + currentEdit.length);

        let editRange = new vscode.Range(start, end);

        edits.push(new vscode.TextEdit(editRange, currentEdit.text));
        currentEdit = null;
      };

      parser.onend = () => {
        resolve(edits);
      };

      parser.write(xml);
      parser.end();
    });
  }

  /// Get execute name in clang-format.executable, if not found, use default value
  /// If configure has changed, it will get the new value
  private getClangFormatExecutablePath() {
    let execPath = vscode.workspace.getConfiguration('clang-format').get<string>('executable');
    if (!execPath) {
      console.log('no clang-format path configuration!');
      return 'clang-format';
    }

    // replace placeholders, if present
    return execPath
      .replace(/\${workspaceRoot}/g, vscode.workspace.rootPath)
      .replace(/\${cwd}/g, process.cwd())
      .replace(/\${env\.([^}]+)}/g, (sub: string, envName: string) => {
        return process.env[envName];
      });
  }

  private getClangTidyExecutablePath() {
    let execPath = vscode.workspace.getConfiguration('clang-tidy').get<string>('executable');
    if (!execPath) {
      console.log('no clang-tidy path configuration!');
      return 'clang-tidy';
    }

    // replace placeholders, if present
    return execPath
      .replace(/\${workspaceRoot}/g, vscode.workspace.rootPath)
      .replace(/\${cwd}/g, process.cwd())
      .replace(/\${env\.([^}]+)}/g, (sub: string, envName: string) => {
        return process.env[envName];
      });
  }

  private doClangFormat(document: vscode.TextDocument): Thenable<vscode.TextEdit[]> {
    return new Promise((resolve, reject) => {
      let filename = document.fileName;

      let clangFormatCommandBinPath = this.getClangFormatExecutablePath();
      let codeContent = document.getText();

      //use inplace mode or export change mode
      let formatArgs = [
        //'-output-replacements-xml',
        filename,
        '-i'
      ];

      let workingPath = vscode.workspace.rootPath;
      if (!document.isUntitled) {
        workingPath = path.dirname(document.fileName);
      }

      let stdout = '';
      let stderr = '';
      let child = cp.spawn(clangFormatCommandBinPath, formatArgs, { cwd: workingPath });
      child.stdin.end(codeContent);
      child.stdout.on('data', chunk => stdout += chunk);
      child.stderr.on('data', chunk => stderr += chunk);
      child.on('error', err => {
        if (err && (<any>err).code === 'ENOENT') {
          vscode.window.showInformationMessage('The \'' + clangFormatCommandBinPath + '\' command is not available.  Please check your clang-format.executable user setting and ensure it is installed.');
          return resolve(null);
        }
        return reject(err);
      });
      child.on('close', code => {
        try {
          if (stderr.length != 0) {
            outputChannel.show();
            outputChannel.clear();
            outputChannel.appendLine(stderr);
            return reject('Cannot format due to syntax errors.');
          }

          if (code != 0) {
            return reject();
          }

          return resolve(this.getEdits(document, stdout, codeContent));
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  private doClangTidy(document: vscode.TextDocument): Thenable<vscode.TextEdit[]> {
    return new Promise((resolve, reject) => {
      let filename = document.fileName;

      let clangTidyCommandBinPath = this.getClangTidyExecutablePath();
      let codeContent = document.getText();

      let workingPath = vscode.workspace.rootPath;
      /*if (!document.isUntitled) {
        workingPath = path.dirname(document.fileName);
      }*/
      let include_path = vscode.workspace.getConfiguration('clang-tidy').get<string[]>('includePath');
      let system_include_path = vscode.workspace.getConfiguration('clang-tidy').get<string[]>('systemIncludePath');
      let extra_compile_arg = vscode.workspace.getConfiguration('clang-tidy').get<string[]>('extraCompileArg');

      // use inplace mode or export change mode
      let tidyArgs = [
        document.fileName,
        //'-export-fixes='+workingPath+'/fixes.yml',
        '-fix',
        '-fix-errors'
      ];

      include_path.forEach((arg) => { tidyArgs.push('-extra-arg=-I' + arg.replace(/\${workspaceFolder}/g, vscode.workspace.rootPath)); });
      system_include_path.forEach((arg) => { tidyArgs.push('-extra-arg=-isystem' + arg.replace(/\${workspaceFolder}/g, vscode.workspace.rootPath)); });
      extra_compile_arg.forEach((arg) => { tidyArgs.push('-extra-arg-before=' + arg.replace(/\${workspaceFolder}/g, vscode.workspace.rootPath)); });

      let stdout = '';
      let stderr = '';
      let child = cp.spawn(clangTidyCommandBinPath, tidyArgs, { cwd: workingPath });
      console.log('tidy args:\n');
      console.log(tidyArgs);
      child.stdin.end(codeContent);
      child.stdout.on('data', chunk => stdout += chunk);
      child.stderr.on('data', chunk => stderr += chunk);
      child.on('error', err => {
        if (err && (<any>err).code === 'ENOENT') {
          vscode.window.showInformationMessage('The \'' + clangTidyCommandBinPath + '\' command is not available.  Please check your clang-format.executable user setting and ensure it is installed.');
          return resolve(null);
        }
        //return reject(err);
      });
      child.on('close', code => {
        try {
          if (stderr.length != 0) {
            outputChannel.show();
            outputChannel.clear();
            outputChannel.appendLine(stderr);
            outputChannel.appendLine(tidyArgs.join(' '));
            //return reject('Cannot format due to syntax errors.');
          }

          if (code != 0) {
            //return reject();
          }

          return resolve([]);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  private doFormatDocument(document: vscode.TextDocument, options: vscode.FormattingOptions, token: vscode.CancellationToken): Thenable<vscode.TextEdit[]> {

    return new Promise((resolve, reject) => {
      Promise.all([this.doClangFormat(document), this.doClangTidy(document)]).then((values) => {
        resolve(values[0].concat(values[1]));
      });
    });
  }

  public formatDocument(document: vscode.TextDocument): Thenable<vscode.TextEdit[]> {
    return this.doFormatDocument(document, null, null);
  }
}

let diagnosticCollection: vscode.DiagnosticCollection;

//initialize format provider
export function activate(ctx: vscode.ExtensionContext): void {

  let formatter = new ClangDocumentFormattingEditProvider();
  let availableLanguages = {};

  MODES.forEach((mode) => {
    ctx.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(mode, formatter));
    availableLanguages[mode.language] = true;
  });
}
