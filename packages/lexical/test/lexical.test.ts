import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  normalizeLiteral,
  tokenize,
} from '#/index';
import {
  normalizeLiteral as legacyNormalizeLiteral,
  tokenize as legacyTokenize,
} from '../../minidb/src/index';

test('legacy APIs re-export the lexical implementations', () => {
  assert.equal(legacyTokenize, tokenize);
  assert.equal(legacyNormalizeLiteral, normalizeLiteral);
});

test('tokenize emits lowercase latin words and CJK UTF-16 uni/bigrams', () => {
  assert.deepEqual(tokenize('Hello WORLD 42'), ['hello', 'world', '42']);
  assert.deepEqual(tokenize('北京'), ['北', '北京', '京']);
  assert.deepEqual(tokenize('你好，世界'), [
    '你',
    '你好',
    '好',
    '好，',
    '，',
    '，世',
    '世',
    '世界',
    '界',
  ]);
  assert.deepEqual(tokenize('𠀀'), []);
});

test('tokenize converts unknown inputs with String', () => {
  assert.deepEqual(tokenize(null), ['null']);
  assert.deepEqual(tokenize(2026), ['2026']);
  assert.deepEqual(tokenize({ toString: () => 'Hello北京' }), ['hello', '北', '北京', '京']);
});

test('tokenize drops ASCII terms longer than 65535 characters', () => {
  const accepted = 'a'.repeat(0xffff);
  assert.deepEqual(tokenize(accepted), [accepted]);
  assert.deepEqual(tokenize('a'.repeat(0x10000)), []);
});

test('tokenize does not apply NFKC to fullwidth terms', () => {
  assert.deepEqual(tokenize('ＦＯＯ'), ['ｆ', 'ｆｏ', 'ｏ', 'ｏｏ', 'ｏ']);
  assert.notDeepEqual(tokenize('ＦＯＯ'), tokenize('foo'));
});

test('normalizeLiteral lowercases and applies NFKC', () => {
  assert.equal(normalizeLiteral('AbC'), 'abc');
  assert.equal(normalizeLiteral('ＦＯＯ'), normalizeLiteral('foo'));
  assert.equal(normalizeLiteral('ﬀ'), 'ff');
  assert.equal(normalizeLiteral('＄100'), '$100');
  assert.equal(Array.from(normalizeLiteral('A🙂')).length, 2);
});
