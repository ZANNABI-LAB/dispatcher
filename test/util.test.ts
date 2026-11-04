import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { splitCommand } from "../src/util";

test("splitCommand: ~ 확장 (v0.3 README 버그 수정)", () => {
  expect(splitCommand("python3 ~/bin/app_token.py")).toEqual(["python3", `${homedir()}/bin/app_token.py`]);
});

test("splitCommand: 따옴표와 공백", () => {
  expect(splitCommand(`a "b c" 'd e' f~`)).toEqual(["a", "b c", "d e", "f~"]);
  expect(splitCommand(`x ""`)).toEqual(["x", ""]);
  expect(() => splitCommand(`a "b`)).toThrow();
});
