"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const markdown_it_1 = __importDefault(require("markdown-it"));
const criticmarkup_plugin_1 = require("./src/preview/criticmarkup-plugin");
const md = new markdown_it_1.default();
md.use(criticmarkup_plugin_1.criticmarkupPlugin);
// Test case from failure: [["!","-","!"]]
const lines = ["!", "-", "!"];
const text = lines.join('\n');
const input = `{>>${text}<<}`;
console.log('Input:', JSON.stringify(input));
const output = md.render(input);
console.log('Output:', output);
console.log('Contains criticmarkup-comment:', output.includes('criticmarkup-comment'));
console.log('Contains span:', output.includes('<span'));
// Test another failing case
const lines2 = ["!", "=", "!"];
const text2 = lines2.join('\n');
const input2 = `{++${text2}++}`;
console.log('\nInput2:', JSON.stringify(input2));
const output2 = md.render(input2);
console.log('Output2:', output2);
console.log('Contains criticmarkup-addition:', output2.includes('criticmarkup-addition'));
//# sourceMappingURL=test-debug.js.map