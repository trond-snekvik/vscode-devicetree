
#define NORMAL 0
#define NORMAL 0 // fail (duplicate)
#define NORMAL_WITH_ARGS(a) valid
#define NORMAL_WITH_ARGS(a) valid // fail (duplicate)
#undef NON_EXISTING // fail
#nonsense // fail
#define // fail
#undef // fail
#if // fail
#endif
#include // fail
#ifdef // fail
#endif

#ifndef // fail
#endif

