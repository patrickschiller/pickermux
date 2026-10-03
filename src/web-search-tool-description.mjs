import { createHash } from "node:crypto";

// Copyright 2025 OpenAI. The compact description below is a PickerMux adaptation
// of codex-rs/ext/web-search/web_run_description.md at OpenAI Codex commit
// 36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564, licensed under Apache-2.0 (copy below).
// Only this reviewed identity and exact upstream text may lose explanatory
// repetition. Future or caller-edited policy must pass through unchanged.
const UPSTREAM_DESCRIPTION_LENGTH = 7507;
const UPSTREAM_DESCRIPTION_SHA256 =
  "1f3879b44690eb7aad9ba97351acda16c4d0c26847bcb4af2964d5989404407e";

const COMPACT_DESCRIPTION = `Codex web.run internet tool. Call its advertised function name, even when renamed by the bridge. Operations are parameters, not separate tools: search_query, image_query, open, click, find, screenshot (PDF pages), finance, weather, sports, and time. Use the supplied parameter schema.
open.ref_id accepts a full URL or result ID: {"open":[{"ref_id":"https://example.org/source"}]}. find searches text within a page.

Efficiency: batch independent queries/operations in one call. response_length controls result count; omit for short. Omit unneeded optional parameters, empty lists, and nulls. At most 4 search_query entries per call; 4 require response_length medium or long. After an accidental web.run call, send {"search_query":[{"q":""}]}.

Search requirements:
- Obey explicit requests to search/browse/verify/look up current information, and explicit requests not to search.
- Check assumptions for temporal stability: MUST search if there is even a small (>10%) chance they changed. When unsure or on the fence, MUST browse.
- MUST browse for potentially changed information: news, prices, laws, schedules, product specs, sports scores, economic indicators, political/public/company figures, rules, regulations, standards, software libraries, exchange rates, and recommendations influenced by current availability, popularity, safety, or culture. This list is not exhaustive. For news, prioritize recent events and compare publication dates with event dates.
- MUST browse for recommendations involving substantial time/money (products, restaurants, travel, etc.); needed or beneficial direct quotes, links, or precise attribution; or a referenced page, paper, dataset, PDF, or site whose contents were not provided.
- MUST browse when unsure of a fact, for niche/emerging topics, or if recall may be wrong with >=10% probability. For high-stakes medical/legal/financial accuracy, search by default because information is unstable.

Citations:
Results include internal reference IDs such as turn2search5. Use IDs only in web.run calls, never in the final response. Cite with descriptive Markdown links directly to supporting pages, not search-result pages or bare URLs: [title](https://example.com/page). Give separate links for multiple sources.
Put each citation beside its claim, normally after the sentence/paragraph and punctuation; never inside code fences, on a line alone, or collected at the end. Cite web-supported statements when browsing. Each source must directly support its associated claim. Prefer primary/authoritative sources and diverse domains when multiple perspectives help.

Special cases override conflicting instructions:
- For OpenAI-product usage (ChatGPT, OpenAI API, etc.), inspect local environment code first; browse as fallback, restricting search to official OpenAI sites with the domains filter unless otherwise requested.
- Technical search answers must rely only on primary sources (papers, official documentation, etc.).
- Clearly label inferences from sources.

Source/copyright limits:
Never provide full articles, long verbatim passages, or extensive direct quotes. For requested verbatim text, give a short compliant excerpt then paraphrase/summarize.
Quote at most 25 words verbatim per single non-lyrical source, or 10 words of song lyrics. Long Reddit quotes are allowed only as exact, linked Markdown blockquotes (>) identified as direct quotes.
Each source's [wordlim N] caps all response words attributed to it, including non-contiguous derived passages; default N=200. This is a maximum per source. Relevant sources' summarization limits add together; every used source must be relevant. Reddit is exempt from these limits when properly identified, quoted, and linked as above.
`;

export function compactWebSearchToolDescription({ namespace, name, description }) {
  if (
    namespace !== "web" ||
    name !== "run" ||
    typeof description !== "string" ||
    description.length !== UPSTREAM_DESCRIPTION_LENGTH
  ) {
    return description;
  }

  const digest = createHash("sha256").update(description, "utf8").digest("hex");
  return digest === UPSTREAM_DESCRIPTION_SHA256 ? COMPACT_DESCRIPTION : description;
}

/*
The adapted description is distributed with the original OpenAI license below.
The upstream NOTICE attribution applicable to this text is:
OpenAI Codex
Copyright 2025 OpenAI

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1.  Definitions.

    "License" shall mean the terms and conditions for use, reproduction,
    and distribution as defined by Sections 1 through 9 of this document.

    "Licensor" shall mean the copyright owner or entity authorized by
    the copyright owner that is granting the License.

    "Legal Entity" shall mean the union of the acting entity and all
    other entities that control, are controlled by, or are under common
    control with that entity. For the purposes of this definition,
    "control" means (i) the power, direct or indirect, to cause the
    direction or management of such entity, whether by contract or
    otherwise, or (ii) ownership of fifty percent (50%) or more of the
    outstanding shares, or (iii) beneficial ownership of such entity.

    "You" (or "Your") shall mean an individual or Legal Entity
    exercising permissions granted by this License.

    "Source" form shall mean the preferred form for making modifications,
    including but not limited to software source code, documentation
    source, and configuration files.

    "Object" form shall mean any form resulting from mechanical
    transformation or translation of a Source form, including but
    not limited to compiled object code, generated documentation,
    and conversions to other media types.

    "Work" shall mean the work of authorship, whether in Source or
    Object form, made available under the License, as indicated by a
    copyright notice that is included in or attached to the work
    (an example is provided in the Appendix below).

    "Derivative Works" shall mean any work, whether in Source or Object
    form, that is based on (or derived from) the Work and for which the
    editorial revisions, annotations, elaborations, or other modifications
    represent, as a whole, an original work of authorship. For the purposes
    of this License, Derivative Works shall not include works that remain
    separable from, or merely link (or bind by name) to the interfaces of,
    the Work and Derivative Works thereof.

    "Contribution" shall mean any work of authorship, including
    the original version of the Work and any modifications or additions
    to that Work or Derivative Works thereof, that is intentionally
    submitted to Licensor for inclusion in the Work by the copyright owner
    or by an individual or Legal Entity authorized to submit on behalf of
    the copyright owner. For the purposes of this definition, "submitted"
    means any form of electronic, verbal, or written communication sent
    to the Licensor or its representatives, including but not limited to
    communication on electronic mailing lists, source code control systems,
    and issue tracking systems that are managed by, or on behalf of, the
    Licensor for the purpose of discussing and improving the Work, but
    excluding communication that is conspicuously marked or otherwise
    designated in writing by the copyright owner as "Not a Contribution."

    "Contributor" shall mean Licensor and any individual or Legal Entity
    on behalf of whom a Contribution has been received by Licensor and
    subsequently incorporated within the Work.

2.  Grant of Copyright License. Subject to the terms and conditions of
    this License, each Contributor hereby grants to You a perpetual,
    worldwide, non-exclusive, no-charge, royalty-free, irrevocable
    copyright license to reproduce, prepare Derivative Works of,
    publicly display, publicly perform, sublicense, and distribute the
    Work and such Derivative Works in Source or Object form.

3.  Grant of Patent License. Subject to the terms and conditions of
    this License, each Contributor hereby grants to You a perpetual,
    worldwide, non-exclusive, no-charge, royalty-free, irrevocable
    (except as stated in this section) patent license to make, have made,
    use, offer to sell, sell, import, and otherwise transfer the Work,
    where such license applies only to those patent claims licensable
    by such Contributor that are necessarily infringed by their
    Contribution(s) alone or by combination of their Contribution(s)
    with the Work to which such Contribution(s) was submitted. If You
    institute patent litigation against any entity (including a
    cross-claim or counterclaim in a lawsuit) alleging that the Work
    or a Contribution incorporated within the Work constitutes direct
    or contributory patent infringement, then any patent licenses
    granted to You under this License for that Work shall terminate
    as of the date such litigation is filed.

4.  Redistribution. You may reproduce and distribute copies of the
    Work or Derivative Works thereof in any medium, with or without
    modifications, and in Source or Object form, provided that You
    meet the following conditions:

    (a) You must give any other recipients of the Work or
    Derivative Works a copy of this License; and

    (b) You must cause any modified files to carry prominent notices
    stating that You changed the files; and

    (c) You must retain, in the Source form of any Derivative Works
    that You distribute, all copyright, patent, trademark, and
    attribution notices from the Source form of the Work,
    excluding those notices that do not pertain to any part of
    the Derivative Works; and

    (d) If the Work includes a "NOTICE" text file as part of its
    distribution, then any Derivative Works that You distribute must
    include a readable copy of the attribution notices contained
    within such NOTICE file, excluding those notices that do not
    pertain to any part of the Derivative Works, in at least one
    of the following places: within a NOTICE text file distributed
    as part of the Derivative Works; within the Source form or
    documentation, if provided along with the Derivative Works; or,
    within a display generated by the Derivative Works, if and
    wherever such third-party notices normally appear. The contents
    of the NOTICE file are for informational purposes only and
    do not modify the License. You may add Your own attribution
    notices within Derivative Works that You distribute, alongside
    or as an addendum to the NOTICE text from the Work, provided
    that such additional attribution notices cannot be construed
    as modifying the License.

    You may add Your own copyright statement to Your modifications and
    may provide additional or different license terms and conditions
    for use, reproduction, or distribution of Your modifications, or
    for any such Derivative Works as a whole, provided Your use,
    reproduction, and distribution of the Work otherwise complies with
    the conditions stated in this License.

5.  Submission of Contributions. Unless You explicitly state otherwise,
    any Contribution intentionally submitted for inclusion in the Work
    by You to the Licensor shall be under the terms and conditions of
    this License, without any additional terms or conditions.
    Notwithstanding the above, nothing herein shall supersede or modify
    the terms of any separate license agreement you may have executed
    with Licensor regarding such Contributions.

6.  Trademarks. This License does not grant permission to use the trade
    names, trademarks, service marks, or product names of the Licensor,
    except as required for reasonable and customary use in describing the
    origin of the Work and reproducing the content of the NOTICE file.

7.  Disclaimer of Warranty. Unless required by applicable law or
    agreed to in writing, Licensor provides the Work (and each
    Contributor provides its Contributions) on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
    implied, including, without limitation, any warranties or conditions
    of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
    PARTICULAR PURPOSE. You are solely responsible for determining the
    appropriateness of using or redistributing the Work and assume any
    risks associated with Your exercise of permissions under this License.

8.  Limitation of Liability. In no event and under no legal theory,
    whether in tort (including negligence), contract, or otherwise,
    unless required by applicable law (such as deliberate and grossly
    negligent acts) or agreed to in writing, shall any Contributor be
    liable to You for damages, including any direct, indirect, special,
    incidental, or consequential damages of any character arising as a
    result of this License or out of the use or inability to use the
    Work (including but not limited to damages for loss of goodwill,
    work stoppage, computer failure or malfunction, or any and all
    other commercial damages or losses), even if such Contributor
    has been advised of the possibility of such damages.

9.  Accepting Warranty or Additional Liability. While redistributing
    the Work or Derivative Works thereof, You may choose to offer,
    and charge a fee for, acceptance of support, warranty, indemnity,
    or other liability obligations and/or rights consistent with this
    License. However, in accepting such obligations, You may act only
    on Your own behalf and on Your sole responsibility, not on behalf
    of any other Contributor, and only if You agree to indemnify,
    defend, and hold each Contributor harmless for any liability
    incurred by, or claims asserted against, such Contributor by reason
    of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS

APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

Copyright 2025 OpenAI

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
