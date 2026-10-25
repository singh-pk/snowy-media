// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// Repository lint rules that oxlint has no built-in equivalent for.

import blankLineAroundBlocks from "./blank-line-around-blocks.js";
import noAccessModifiers from "./no-access-modifiers.js";
import noAwaitAssertion from "./no-await-assertion.js";
import noClasses from "./no-classes.js";
import noModuleLet from "./no-module-let.js";
import noNestedAwait from "./no-nested-await.js";
import noPlanComments from "./no-plan-comments.js";
import noPromiseChains from "./no-promise-chains.js";
import noSetInterval from "./no-set-interval.js";
import noTimers from "./no-timers.js";

export default {
  meta: { name: "repo" },
  rules: {
    "blank-line-around-blocks": blankLineAroundBlocks,
    "no-access-modifiers": noAccessModifiers,
    "no-await-assertion": noAwaitAssertion,
    "no-classes": noClasses,
    "no-module-let": noModuleLet,
    "no-nested-await": noNestedAwait,
    "no-plan-comments": noPlanComments,
    "no-promise-chains": noPromiseChains,
    "no-set-interval": noSetInterval,
    "no-timers": noTimers,
  },
};
