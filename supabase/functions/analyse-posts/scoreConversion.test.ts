import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { displayScore } from './scoreConversion.ts';

Deno.test('displayScore at -1 maps to 0', () => {
  assertEquals(displayScore(-1), 0);
});

Deno.test('displayScore at 0 maps to 50', () => {
  assertEquals(displayScore(0), 50);
});

Deno.test('displayScore at 1 maps to 100', () => {
  assertEquals(displayScore(1), 100);
});

Deno.test('displayScore at representative decimal 0.42 rounds correctly', () => {
  // (0.42 + 1) * 50 = 71
  assertEquals(displayScore(0.42), 71);
});

Deno.test('displayScore at representative decimal -0.256 rounds correctly', () => {
  // (-0.256 + 1) * 50 = 37.2 -> rounds to 37
  assertEquals(displayScore(-0.256), 37);
});

Deno.test('displayScore at representative decimal 0.005 rounds up at the boundary', () => {
  // (0.005 + 1) * 50 = 50.25 -> rounds to 50
  assertEquals(displayScore(0.005), 50);
});
