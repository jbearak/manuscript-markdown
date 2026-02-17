
const assert = require('assert');

function shouldHideSuggestOnCitekeySemicolon(
    linePrefix,
    changeText
) {
    const hasDelimiterChange = changeText.includes(';') || changeText === ' ';
    if (!hasDelimiterChange) {
        return false;
    }
    // const cursor = editor.selection.active;
    // const linePrefix = editor.document.lineAt(cursor.line).text.slice(0, cursor.character);
    return /\[[^\]\n]*;\s*$/.test(linePrefix) && linePrefix.includes('@');
}

// Case 1: Typing ; in a citation
console.log('Case 1: [@foo;', shouldHideSuggestOnCitekeySemicolon('[@foo;', ';'));

// Case 2: Typing space after ;
console.log('Case 2: [@foo; ', shouldHideSuggestOnCitekeySemicolon('[@foo; ', ' '));

// Case 3: Typing ; outside citation
console.log('Case 3: @foo;', shouldHideSuggestOnCitekeySemicolon('@foo;', ';'));

// Case 4: Typing ; in text
console.log('Case 4: text;', shouldHideSuggestOnCitekeySemicolon('text;', ';'));

// Case 5: Typing ; in citation with multiple keys
console.log('Case 5: [@foo; @bar;', shouldHideSuggestOnCitekeySemicolon('[@foo; @bar;', ';'));

