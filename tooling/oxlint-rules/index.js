// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// Repository lint rules that oxlint has no built-in equivalent for.

import blankLineAroundBlocks from "./blank-line-around-blocks.js";
import disableNeedsReason from "./disable-needs-reason.js";
import noAccessModifiers from "./no-access-modifiers.js";
import noAwaitAssertion from "./no-await-assertion.js";
import noClasses from "./no-classes.js";
import noConditionalExpect from "./no-conditional-expect.js";
import noFocusedTests from "./no-focused-tests.js";
import noModuleLet from "./no-module-let.js";
import noNestedAwait from "./no-nested-await.js";
import noProcessComments from "./no-process-comments.js";
import noPromiseChains from "./no-promise-chains.js";
import noSetInterval from "./no-set-interval.js";
import noTimers from "./no-timers.js";
import testHasAssertion from "./test-has-assertion.js";

export default {
  meta: { name: "repo" },
  rules: {
    "blank-line-around-blocks": blankLineAroundBlocks,
    "disable-needs-reason": disableNeedsReason,
    "no-access-modifiers": noAccessModifiers,
    "no-await-assertion": noAwaitAssertion,
    "no-classes": noClasses,
    "no-conditional-expect": noConditionalExpect,
    "no-focused-tests": noFocusedTests,
    "no-module-let": noModuleLet,
    "no-nested-await": noNestedAwait,
    "no-process-comments": noProcessComments,
    "no-promise-chains": noPromiseChains,
    "no-set-interval": noSetInterval,
    "no-timers": noTimers,
    "test-has-assertion": testHasAssertion,
  },
};
