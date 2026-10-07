const normalizeIdentifier = (value) => value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
export function matchProductIdentity(expected, actual) {
    const exactFields = ["sku", "upc", "mpn"];
    const expectedExactFields = exactFields.filter((field) => expected[field] !== undefined);
    const comparableExactFields = expectedExactFields.filter((field) => actual[field] !== undefined);
    const matchedIdentifiers = comparableExactFields.filter((field) => normalizeIdentifier(expected[field]) === normalizeIdentifier(actual[field]));
    if (comparableExactFields.length > 0) {
        return {
            matches: matchedIdentifiers.length === comparableExactFields.length,
            confidence: matchedIdentifiers.length / expectedExactFields.length,
            matchedIdentifiers,
        };
    }
    if (expected.name && actual.name) {
        const expectedName = normalizeIdentifier(expected.name);
        const actualName = normalizeIdentifier(actual.name);
        const matches = expectedName.length > 0 &&
            (expectedName === actualName ||
                expectedName.includes(actualName) ||
                actualName.includes(expectedName));
        return {
            matches,
            confidence: matches ? 0.8 : 0,
            matchedIdentifiers: matches ? ["name"] : [],
        };
    }
    return { matches: true, confidence: 0, matchedIdentifiers: [] };
}
