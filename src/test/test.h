// Hello

#include "test.c"
// Should only process test.c once because of #pragma once
#include "test.c"
#define SHOULD_PROCESS_FIRST_LINE_AFTER_GETTING_OUT_OF_PRAGMA_ONCE 1 // known issue

#define YES 1

#if YES
#define SOME_SUM 123 + 456
#else
#error "oh no!"
#endif

#ifdef YES
#define SOME_LARGE_NUMBER 999
#endif

#if SOME_LARGE_NUMBER > SOME_SUM
//comments are not included
#endif

#ifdef HELLO
#endif

#if defined(YES) && !defined(NO)
SHOULD BE INCLUDED
#else
SHOULD NOT BE INCLUDED
#endif

/* block comments aren't evaluated
#ifndef YES
// this shouldn't be in the compiled file.
#else
// this should.
#endif
THIS IS EXCLUDED
*/
YES + SOME_SUM
this is some text that will just be included as is.

We found this in test.c: INCLUDED_TEST_C

#define RECURSIVE YES + SOME_SUM

SOME NUMBERS: RECURSIVE

#define MACRO(aa, bb, cc) aa + bb + cc

SUM: MACRO(RECURSIVE, MACRO(1, 2, 3), 8 + 9)

#define CONCAT_TEST(a, b) a##b test_##a b##_test test_##a##b##_test
#define STRINGIFY(a) #a

CONCAT_TEST(first, second)
STRINGIFY(this should be a string)

#define VAR_ARGS(a, b, ...) a, b, __VA_ARGS__
#define VAR_ARGS_OPT_ARGS(a, b, ...) a, b, ##__VA_ARGS__

VAR_ARGS(1, 2, 3, 4, 5) // 1, 2, 3, 4, 5
VAR_ARGS_OPT_ARGS(1, 2, 3, 4, 5) // 1, 2, 3, 4, 5
VAR_ARGS(1, 2) // 1, 2,
VAR_ARGS_OPT_ARGS(1, 2) // 1, 2

current line: __LINE__
current file: __FILE__

#ifdef TEST_DIAGS

#ifdef TEST_VALID_DIRECTIVES

#define NORMAL 0
#define NO_VALUE
#define NORMAL_WITH_ARGS(a) valid
#define case_sensitive(a) valid
#define CASE_SENSITIVE(a) should not be a duplicate
#define NO_ARGUMENTS() valid
#define SPACE_BEFORE_ARGUMENTS (a) valid
#define NO_VALUE_WITH_ARGS(a)
#define MULTIPLE_ARGS(a, b, c) a + b + c
#define VARIABLE_ARGS(a, b, c, ...) a + b + c + __VA_ARGS__

#undef NO_VALUE
#undef NORMAL

#endif

#ifdef TEST_INVALID_DIRECTIVES
#include "test.invalid.c"
#endif

#endif