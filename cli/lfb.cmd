@echo off
rem Large File Bridge CLI — Windows entry point (pm/cli.mdx §1.1). The shim itself is lfb.mjs, in Node;
rem this only makes `lfb …` callable from cmd.exe and PowerShell. POSIX shells use ./lfb beside it.
node "%~dp0lfb.mjs" %*
