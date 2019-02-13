import * as vscode from 'vscode';

//those languages can all be format by clang-format
let languages: string[] = ['cpp', 'c', 'objective-c', 'objective-cpp', 'java', 'javascript', 'typescript', 'proto', 'proto3', 'apex', 'glsl', 'cuda'];

export const MODES: vscode.DocumentFilter[] = languages.map((language) => ({language, scheme: 'file'}));