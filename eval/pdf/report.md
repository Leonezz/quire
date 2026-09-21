# PDF reflow eval — rules vs Jev — 2026-09-21

20 PDFs. Jev judged at most the first N pages of each (N is the second number in the "pages" column: 24 on this run, other rows keep the cap of the run that produced them); the rest keep the rules. Run budget 2,000,000 input tokens.

## Per PDF

| pdf | kind | rules report | jev report | jev asked / changed | jev tokens · requests · pages | jev wall time |
|---|---|---|---|---|---|---|
| arxiv-attention-neurips | arxiv | 15 p · 1 col · 14 furn · 25 head · 135 para · 7 fig | 15 p · 1 col · 18 furn · 25 head · 132 para · 8 fig | 42 asked · 15 changed | 23,146 in / 4,373 out · 10 req · 10/24 p | 3.4 s (rules 1.2 s) |
| arxiv-bert-acl-2col | arxiv | 16 p · 2 col · 0 furn · 28 head · 208 para · 12 fig | 16 p · 2 col · 0 furn · 29 head · 202 para · 13 fig | 75 asked · 8 changed | 28,853 in / 5,390 out · 11 req · 11/12 p | 2.9 s (rules 1.1 s) |
| arxiv-ddpm-math | arxiv | 25 p · 1 col · 24 furn · 23 head · 191 para · 23 fig | 25 p · 1 col · 25 furn · 24 head · 189 para · 23 fig | 68 asked · 24 changed | 35,764 in / 7,120 out · 12 req · 12/24 p | 35.6 s (rules 28.7 s) |
| arxiv-lora-iclr-tables | arxiv | 26 p · 1 col · 26 furn · 13 head · 299 para · 22 fig | 26 p · 1 col · 26 furn · 24 head · 262 para · 25 fig | 153 asked · 51 changed | 47,563 in / 10,022 out · 11 req · 11/12 p | 6.5 s (rules 4.3 s) |
| arxiv-resnet-cvpr-2col | arxiv | 12 p · 2 col · 12 furn · 14 head · 155 para · 22 fig | 12 p · 2 col · 12 furn · 15 head · 143 para · 29 fig | 94 asked · 63 changed | 48,453 in / 9,809 out · 12 req · 12/12 p | 2.8 s (rules 0.9 s) |
| arxiv-roberta-tables | arxiv | 13 p · 2 col · 0 furn · 27 head · 176 para · 12 fig | 13 p · 2 col · 0 furn · 28 head · 167 para · 18 fig | 76 asked · 13 changed | 39,577 in / 7,857 out · 13 req · 13/24 p | 3.0 s (rules 0.4 s) |
| arxiv-sklearn-jmlr | arxiv | 6 p · 1 col · 8 furn · 2 head · 75 para · 1 fig | 6 p · 1 col · 11 furn · 7 head · 68 para · 1 fig | 45 asked · 7 changed | 21,260 in / 4,712 out · 5 req · 5/24 p | 1.9 s (rules 0.1 s) |
| arxiv-vit-iclr-1col | arxiv | 22 p · 1 col · 44 furn · 10 head · 235 para · 19 fig | 22 p · 1 col · 44 furn · 34 head · 164 para · 63 fig | 112 asked · 87 changed | 58,166 in / 11,741 out · 19 req · 19/24 p | 8.3 s (rules 1.9 s) |
| book-think-python | book | 244 p · 1 col · 0 furn · 389 head · 3368 para · 29 fig · degraded 1 | 244 p · 1 col · 5 furn · 390 head · 3364 para · 29 fig · degraded 1 | 2359 asked · 8 changed | 120,593 in / 27,638 out · 24 req · 24/24 p | 6.9 s (rules 1.3 s) |
| ecma-404-json | spec | 16 p · 1 col · 10 furn · 29 head · 86 para · 0 fig · degraded 1 | 16 p · 1 col · 17 furn · 30 head · 79 para · 0 fig · degraded 1 | 82 asked · 18 changed | 39,787 in / 8,678 out · 13 req · 13/24 p | 2.2 s (rules 0.2 s) |
| letter-berkshire-2023 | magazine | 16 p · 1 col · 16 furn · 7 head · 128 para · 1 fig | 16 p · 1 col · 16 furn · 9 head · 118 para · 9 fig | 35 asked · 11 changed | 21,364 in / 3,692 out · 13 req · 13/24 p | 2.0 s (rules 0.2 s) |
| rfc8949-cbor | rfc | 66 p · 1 col · 195 furn · 73 head · 893 para · 23 fig | 66 p · 1 col · 266 furn · 105 head · 836 para · 24 fig | 564 asked · 57 changed | 94,312 in / 20,955 out · 24 req · 24/24 p | 6.0 s (rules 0.8 s) |
| rfc9111-caching | rfc | 35 p · 1 col · 102 furn · 61 head · 572 para · 4 fig | 35 p · 1 col · 128 furn · 86 head · 533 para · 4 fig | 378 asked · 53 changed | 67,249 in / 15,716 out · 12 req · 12/12 p | 2.6 s (rules 0.4 s) |
| rfc9112-http11 | rfc | 46 p · 1 col · 135 furn · 69 head · 683 para · 8 fig | 46 p · 1 col · 188 furn · 117 head · 608 para · 8 fig | 466 asked · 92 changed | 106,855 in / 24,323 out · 24 req · 24/24 p | 5.3 s (rules 0.4 s) |
| scanned-naca-report | scanned | 18 p · 2 col · 12 furn · 46 head · 383 para · 2 fig | 18 p · 2 col · 12 furn · 53 head · 375 para · 2 fig | 338 asked · 43 changed | 98,189 in / 23,263 out · 12 req · 12/12 p | 2.2 s (rules 0.2 s) |
| slides-cs224n-l1 | slides | 40 p · 1 col · 37 furn · 37 head · 214 para · 2 fig · degraded 2 | 40 p · 1 col · 37 furn · 39 head · 212 para · 2 fig · degraded 2 | 248 asked · 13 changed | 79,643 in / 18,079 out · 24 req · 24/24 p | 4.6 s (rules 0.8 s) |
| slides-cs231n-l1 | slides | 48 p · 1 col · 144 furn · 110 head · 162 para · 2 fig | 48 p · 1 col · 166 furn · 114 head · 147 para · 2 fig | 269 asked · 18 changed | 64,352 in / 14,414 out · 24 req · 24/24 p | 5.8 s (rules 1.6 s) |
| thesis-berkeley-eecs | thesis | 16 p · 2 col · 0 furn · 30 head · 132 para · 18 fig · degraded 1 | 16 p · 2 col · 3 furn · 34 head · 126 para · 18 fig · degraded 1 | 93 asked · 16 changed | 47,411 in / 9,665 out · 15 req · 15/24 p | 5.5 s (rules 2.4 s) |
| unicode-ch02 | spec | 63 p · 1 col · 177 furn · 146 head · 498 para · 1 fig | 63 p · 1 col · 178 furn · 135 head · 495 para · 10 fig | 341 asked · 23 changed | 54,338 in / 11,366 out · 19 req · 19/24 p | 3.8 s (rules 0.4 s) |
| whitepaper-bitcoin | magazine | 9 p · 1 col · 0 furn · 4 head · 127 para · 0 fig | 9 p · 1 col · 7 furn · 8 head · 116 para · 0 fig | 91 asked · 16 changed | 42,468 in / 9,635 out · 9 req · 9/24 p | 2.5 s (rules 0.1 s) |

## Totals

- Blocks: 10,071; asked (gate): 5,929 (59%); changed by Jev: 636 (11% of asked)
- Jev: 306 requests, 1,139,343 input tokens, 248,448 output tokens → $0.0479 at $0.042/M input
- Wall time: rules 47.4 s, Jev builds 113.8 s over 20 PDFs (5.7 s each)

## Human verdicts (five PDFs, read side by side)

Read from `out/<slug>.json` (`plain` and `markdown` of both builds). First run 2026-09-22 with Jev on the first 24 pages; the five PDFs below were rerun after three fixes (merged table crops, run-in / prose heading guard, furniture guard + split-title merge) with Jev on the first 12 pages to stay under 300k tokens, so "changed" counts are not directly comparable across the two runs. The 24-page outputs are kept in `out/before-24p/`.

| pdf | before (24 p): asked / changed · head · fig · tokens | after (12 p): asked / changed · head · fig · tokens |
|---|---|---|
| arxiv-lora-iclr-tables | 153 / 83 · 37 headings · 60 figures · 76,832 | 153 / 51 · 24 headings · 25 figures · 47,563 |
| arxiv-resnet-cvpr-2col | 94 / 63 · 16 · 30 · 48,123 | 94 / 63 · 15 · 29 · 48,453 |
| arxiv-bert-acl-2col | 75 / 10 · 30 · 16 · 40,881 | 75 / 8 · 29 · 13 · 28,853 |
| rfc9111-caching | 378 / 76 · 93 · 4 · 106,301 | 378 / 53 · 86 · 4 · 67,249 |
| scanned-naca-report | 338 / 72 · 58 · 2 · 150,173 | 338 / 43 · 53 · 2 · 98,189 |

Rerun spend: 290,307 input tokens (five PDFs, both ResNet runs covered all 12 pages, so its row is the only like-for-like comparison).

- **arxiv-lora-iclr-tables** (ICLR, many tables). *Before*: every table row the rules had spelled out became its own crop (22 → 60 figures, "Table 4 … Table 18" fragments). *After*: adjacent row verdicts merge into one crop per table and the "Table N:" caption paragraph beside it becomes the crop's caption — the GLUE table is one figure captioned "Table 2: RoBERTabase, RoBERTalarge, and DeBERTaXXL …", the E2E table one figure "Table 3: GPT-2 medium (M) …"; 25 figures against the rules' 22. The small-caps section headings the rules miss are still promoted (13 → 24 on 11 judged pages). Net: Jev clearly better; the crop fragmentation is gone.
- **arxiv-resnet-cvpr-2col** (two-column CVPR; the one like-for-like row). *Before*: the bold run-in sentence "Identity vs. Projection Shortcuts. We have shown that" was promoted to a heading. *After*: the run-in hint (bold lead ending in a period, regular text after) keeps it a paragraph; "Related Work" is still promoted from the rules' "1. Related Work" list item. Table crops: the two-row table fragments merged (Table 11/12 and 17/18 pairs are now one crop each); two rows in different columns / further apart than 1.5 line heights stay separate (29 figures vs 30). Reading order and furniture unchanged. Net: Jev better, the regression fixed.
- **arxiv-bert-acl-2col** (two-column NAACL). Small changes either way: the SQuAD leaderboard rows are now one crop instead of three (16 → 13 figures against the rules' 12). The appendix heading "B.1 Detailed Descriptions for the GLUE Benchmark Experiments." is no longer promoted because it is a bold line ending in a period followed by prose — the guard reads it as a run-in; it is in fact a heading, so this is one small loss from the guard. Net: about even; Jev slightly better than the rules (three real table crops).
- **rfc9111-caching** (IETF v3 PDF). *Furniture guard*: as specified (kept only when > 12 words and mid-page) it does not save the table of contents — its lines are 4–8 words ("4.3.4. Freshening Stored Responses upon Validation"), so Jev still drops them on the judged pages (0 of 3 sample lines survive). What the guard does keep is the first page's copyright paragraph (26 words, mid-page), which the earlier run had dropped as furniture; whether that is content is debatable. The lowercase-numbered subsections and the "•text" bullets are still fixed on the judged pages; "Standards Track Page n" feet remain on pages past the cap. Net: Jev still better than the rules for reading; the ToC loss needs a different guard (a run of short numbered lines on pages 2–4, or a per-page "many short lines" heuristic), not a word-count one.
- **scanned-naca-report** (OCR text layer). "STRAIN" / "OF" / "FORCES" are no longer three headings — but only because they sit past page 12 and were not judged this time; the split-title merge is limited to page 1 by design, and this report's page 1 title is a multi-word line, so the merge did not fire here. On the judged pages Jev still promotes the all-caps OCR section titles ("SUMMARY", "APPENDIX A") and demotes garbage equation lines; it also newly promoted two OCR-garbage lines ("a2 ~=” The minus signs are intro-", "except for the ad~tional term …") that the guard cannot catch (they are neither run-ins nor ≥ 25-word prose). Net: mixed, as before; OCR noise makes the judge's answers noisy too.

Where Jev hurt across the corpus after the fixes: headings that end in a period (BERT "B.1 …") are now refused; OCR-garbage lines can still be promoted; a short table of contents can still be dropped as furniture. Where it helped most: unnumbered / small-caps / lowercase-numbered headings (ViT, LoRA, RFCs), page furniture without repetition (RFC copyright on later pages, licence lines on slides), and tables spelled out as text, now cropped as one figure with their caption.

## First 12 lines of `plain`

#### arxiv-attention-neurips — NeurIPS single column

Source: https://arxiv.org/pdf/1706.03762 · 15 pages · 167 blocks, 42 asked (25%)

| # | rules | jev |
|---:|---|---|
| 1 | Provided proper attribution is provided, Google hereby grants permission to reproduce the tables and figures … | Attention Is All You Need |
| 2 | Attention Is All You Need | Ashish Vaswani∗ Noam Shazeer∗ Niki Parmar∗ Jakob Uszkoreit∗ Google Brain Google Brain Google Research Google … |
| 3 | Ashish Vaswani∗ Noam Shazeer∗ Niki Parmar∗ Jakob Uszkoreit∗ Google Brain Google Brain Google Research Google … | Aidan N. Gomez∗ † |
| 4 | Aidan N. Gomez∗ † | Łukasz Kaiser∗ |
| 5 | Łukasz Kaiser∗ | Google Research University of Toronto Google Brain lukaszkaiser@google.com llion@google.com aidan@cs.toronto.… |
| 6 | Google Research University of Toronto Google Brain lukaszkaiser@google.com llion@google.com aidan@cs.toronto.… | Illia Polosukhin∗ ‡ illia.polosukhin@gmail.com |
| 7 | Illia Polosukhin∗ ‡ illia.polosukhin@gmail.com | Abstract |
| 8 | Abstract | The dominant sequence transduction models are based on complex recurrent or convolutional neural networks tha… |
| 9 | The dominant sequence transduction models are based on complex recurrent or convolutional neural networks tha… | Equal contribution. Listing order is random. Jakob proposed replacing RNNs with self-attention and started th… |
| 10 | Equal contribution. Listing order is random. Jakob proposed replacing RNNs with self-attention and started th… | Work performed while at Google Brain. |
| 11 | Work performed while at Google Brain. | Work performed while at Google Research. |
| 12 | Work performed while at Google Research. | 1 Introduction |

#### arxiv-bert-acl-2col — two-column ACL/NAACL

Source: https://arxiv.org/pdf/1810.04805 · 16 pages · 248 blocks, 75 asked (30%)

| # | rules | jev |
|---:|---|---|
| 1 | BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding | BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding |
| 2 | Jacob Devlin Ming-Wei Chang Kenton Lee Kristina Toutanova | Jacob Devlin Ming-Wei Chang Kenton Lee Kristina Toutanova |
| 3 | Google AI Language {jacobdevlin,mingweichang,kentonl,kristout}@google.com | Google AI Language {jacobdevlin,mingweichang,kentonl,kristout}@google.com |
| 4 | Abstract | Abstract |
| 5 | We introduce a new language representation model called BERT, which stands for Bidirectional Encoder Represen… | We introduce a new language representation model called BERT, which stands for Bidirectional Encoder Represen… |
| 6 | BERT is conceptually simple and empirically powerful. It obtains new state-of-the-art results on eleven natur… | BERT is conceptually simple and empirically powerful. It obtains new state-of-the-art results on eleven natur… |
| 7 | 1 Introduction | 1 Introduction |
| 8 | Language model pre-training has been shown to be effective for improving many natural language processing tas… | Language model pre-training has been shown to be effective for improving many natural language processing tas… |
| 9 | There are two existing strategies for applying pre-trained language representations to downstream tasks: feat… | There are two existing strategies for applying pre-trained language representations to downstream tasks: feat… |
| 10 | We argue that current techniques restrict the power of the pre-trained representations, especially for the fi… | We argue that current techniques restrict the power of the pre-trained representations, especially for the fi… |
| 11 | In this paper, we improve the fine-tuning based approaches by proposing BERT: Bidirectional Encoder Represent… | In this paper, we improve the fine-tuning based approaches by proposing BERT: Bidirectional Encoder Represent… |
| 12 | We demonstrate the importance of bidirectional pre-training for language representations. Unlike Radford et a… | We demonstrate the importance of bidirectional pre-training for language representations. Unlike Radford et a… |

#### arxiv-ddpm-math — NeurIPS single column, heavy math

Source: https://arxiv.org/pdf/2006.11239 · 25 pages · 237 blocks, 68 asked (29%)

| # | rules | jev |
|---:|---|---|
| 1 | Denoising Diffusion Probabilistic Models | Denoising Diffusion Probabilistic Models |
| 2 | Jonathan Ho Ajay Jain Pieter Abbeel | Jonathan Ho Ajay Jain Pieter Abbeel |
| 3 | UC Berkeley UC Berkeley UC Berkeley jonathanho@berkeley.edu ajayj@berkeley.edu pabbeel@cs.berkeley.edu | UC Berkeley UC Berkeley UC Berkeley jonathanho@berkeley.edu ajayj@berkeley.edu pabbeel@cs.berkeley.edu |
| 4 | Abstract | Abstract |
| 5 | We present high quality image synthesis results using diffusion probabilistic models, a class of latent varia… | We present high quality image synthesis results using diffusion probabilistic models, a class of latent varia… |
| 6 | 1 Introduction | 1 Introduction |
| 7 | Deep generative models of all kinds have recently exhibited high quality samples in a wide variety of data mo… | Deep generative models of all kinds have recently exhibited high quality samples in a wide variety of data mo… |
| 8 | Figure 1: Generated samples on CelebA-HQ 256 × 256 (left) and unconditional CIFAR10 (right) | Figure 1: Generated samples on CelebA-HQ 256 × 256 (left) and unconditional CIFAR10 (right) |
| 9 | 34th Conference on Neural Information Processing Systems (NeurIPS 2020), Vancouver, Canada. | Figure 2: The directed graphical model considered in this work. |
| 10 | Figure 2: The directed graphical model considered in this work. | This paper presents progress in diffusion probabilistic models [53]. A diffusion probabilistic model (which w… |
| 11 | This paper presents progress in diffusion probabilistic models [53]. A diffusion probabilistic model (which w… | Diffusion models are straightforward to define and efficient to train, but to the best of our knowledge, ther… |
| 12 | Diffusion models are straightforward to define and efficient to train, but to the best of our knowledge, ther… | Despite their sample quality, our models do not have competitive log likelihoods compared to other likelihood… |

#### arxiv-lora-iclr-tables — ICLR single column, many tables

Source: https://arxiv.org/pdf/2106.09685 · 26 pages · 334 blocks, 153 asked (46%)

| # | rules | jev |
|---:|---|---|
| 1 | LORA: LOW-RANK ADAPTATION OF LARGE LAN- | LORA: LOW-RANK ADAPTATION OF LARGE LAN- |
| 2 | GUAGE MODELS | GUAGE MODELS |
| 3 | Edward Hu∗ Yelong Shen∗ Phillip Wallis Zeyuan Allen-Zhu Yuanzhi Li Shean Wang Lu Wang Weizhu Chen | Edward Hu∗ Yelong Shen∗ Phillip Wallis Zeyuan Allen-Zhu Yuanzhi Li Shean Wang Lu Wang Weizhu Chen |
| 4 | Microsoft Corporation {edwardhu, yeshe, phwallis, zeyuana, yuanzhil, swang, luw, wzchen}@microsoft.com yuanzh… | Microsoft Corporation {edwardhu, yeshe, phwallis, zeyuana, yuanzhil, swang, luw, wzchen}@microsoft.com yuanzh… |
| 5 | ABSTRACT | ABSTRACT |
| 6 | An important paradigm of natural language processing consists of large-scale pretraining on general domain da… | An important paradigm of natural language processing consists of large-scale pretraining on general domain da… |
| 7 | 1 INTRODUCTION | 1 INTRODUCTION |
| 8 | Many applications in natural language processing rely on adapt- | Many applications in natural language processing rely on adapt- |
| 9 | f(x) | f(x) |
| 10 | ing one large-scale, pre-trained language model to multiple down- | ing one large-scale, pre-trained language model to multiple down- |
| 11 | h | h |
| 12 | stream applications. Such adaptation is usually done via fine-tuning, which updates all the parameters of the… | stream applications. Such adaptation is usually done via fine-tuning, which updates all the parameters of the… |

#### arxiv-resnet-cvpr-2col — two-column IEEE/CVPR

Source: https://arxiv.org/pdf/1512.03385 · 12 pages · 191 blocks, 94 asked (49%)

| # | rules | jev |
|---:|---|---|
| 1 | Figure 1. Training error (left) and test error (right) on CIFAR-10 | Figure 1. Training error (left) and test error (right) on CIFAR-10 |
| 2 | stead of learning unreferenced functions. We provide com- | stead of learning unreferenced functions. We provide com- |
| 3 | with 20-layer and 56-layer “plain” networks. The deeper network | with 20-layer and 56-layer “plain” networks. The deeper network |
| 4 | prehensive empirical evidence showing that these residual | prehensive empirical evidence showing that these residual |
| 5 | has higher training error, and thus test error. Similar phenomena | has higher training error, and thus test error. Similar phenomena |
| 6 | networks are easier to optimize, and can gain accuracy from | networks are easier to optimize, and can gain accuracy from |
| 7 | on ImageNet is presented in Fig. 4. | on ImageNet is presented in Fig. 4. |
| 8 | considerably increased depth. On the ImageNet dataset we evaluate residual nets with a depth of up to 152 lay… | considerably increased depth. On the ImageNet dataset we evaluate residual nets with a depth of up to 152 lay… |
| 9 | [Table 2] | [Table 2] |
| 10 | depth increasing, accuracy gets saturated (which might be unsurprising) and then degrades rapidly. Unexpected… | depth increasing, accuracy gets saturated (which might be unsurprising) and then degrades rapidly. Unexpected… |
| 11 | Introduction | Introduction |
| 12 | such degradation is not caused by overfitting, and adding Deep convolutional neural networks [22, 21] have le… | such degradation is not caused by overfitting, and adding Deep convolutional neural networks [22, 21] have le… |

#### arxiv-roberta-tables — two-column ACL, many tables

Source: https://arxiv.org/pdf/1907.11692 · 13 pages · 215 blocks, 76 asked (35%)

| # | rules | jev |
|---:|---|---|
| 1 | RoBERTa: A Robustly Optimized BERT Pretraining Approach | RoBERTa: A Robustly Optimized BERT Pretraining Approach |
| 2 | Yinhan Liu∗§ Myle Ott∗§ Naman Goyal∗§ Jingfei Du∗§ Mandar Joshi† | Yinhan Liu∗§ Myle Ott∗§ Naman Goyal∗§ Jingfei Du∗§ Mandar Joshi† |
| 3 | Danqi Chen§ Omer Levy§ Mike Lewis§ Luke Zettlemoyer†§ Veselin Stoyanov§ † Paul G. Allen School of Computer Sc… | Danqi Chen§ Omer Levy§ Mike Lewis§ Luke Zettlemoyer†§ Veselin Stoyanov§ † Paul G. Allen School of Computer Sc… |
| 4 | Abstract | Abstract |
| 5 | We present a replication study of BERT pretraining (Devlin et al., 2019), which includes a | We present a replication study of BERT pretraining (Devlin et al., 2019), which includes a |
| 6 | Language model pretraining has led to sig- | Language model pretraining has led to sig- |
| 7 | careful evaluation of the effects of hyperparmeter | careful evaluation of the effects of hyperparmeter |
| 8 | nificant performance gains but careful com- | nificant performance gains but careful comtuning and training set size. We find that BERT |
| 9 | tuning and training set size. We find that BERT | parison between different approaches is chal- |
| 10 | parison between different approaches is chal- | was significantly undertrained and propose an im- |
| 11 | was significantly undertrained and propose an im- | lenging. Training is computationally expen- |
| 12 | lenging. Training is computationally expen- | proved recipe for training BERT models, which |

#### arxiv-sklearn-jmlr — JMLR-style single column

Source: https://arxiv.org/pdf/1201.0490 · 6 pages · 78 blocks, 45 asked (58%)

| # | rules | jev |
|---:|---|---|
| 1 | Journal of Machine Learning Research 12 (2011) 2825-2830 Submitted 3/11; Revised 8/11; Published 10/11 | Scikit-learn: Machine Learning in Python |
| 2 | Scikit-learn: Machine Learning in Python | Fabian Pedregosa fabian.pedregosa@inria.fr Ga¨el Varoquaux gael.varoquaux@normalesup.org Alexandre Gramfort a… |
| 3 | Fabian Pedregosa fabian.pedregosa@inria.fr Ga¨el Varoquaux gael.varoquaux@normalesup.org Alexandre Gramfort a… | Parietal, INRIA Saclay Neurospin, Bˆat 145, CEA Saclay Gif sur Yvette, France |
| 4 | Parietal, INRIA Saclay Neurospin, Bˆat 145, CEA Saclay Gif sur Yvette, France | Olivier Grisel olivier.grisel@ensta.fr |
| 5 | Olivier Grisel olivier.grisel@ensta.fr | Nuxeo Paris, France |
| 6 | Nuxeo Paris, France | Mathieu Blondel mblondel@ai.cs.kobe-u.ac.jp |
| 7 | Mathieu Blondel mblondel@ai.cs.kobe-u.ac.jp | Kobe University Kobe, Japan |
| 8 | Kobe University Kobe, Japan | Andreas M¨uller andreas.mueller@columbia.edu |
| 9 | Andreas M¨uller andreas.mueller@columbia.edu | Department of Computer Science & Data Science Institute Columbia University New York, USA |
| 10 | Department of Computer Science & Data Science Institute Columbia University New York, USA | Joel Nothman joel.nothman@gmail.com |
| 11 | Joel Nothman joel.nothman@gmail.com | Sydney Informatics Hub University of Sydney, NSW, Australia |
| 12 | Sydney Informatics Hub University of Sydney, NSW, Australia | Gilles Louppe g.louppe@ulg.ac.be |

#### arxiv-vit-iclr-1col — single-column ICLR

Source: https://arxiv.org/pdf/2010.11929 · 22 pages · 264 blocks, 112 asked (42%)

| # | rules | jev |
|---:|---|---|
| 1 | AN IMAGE IS WORTH 16X16 WORDS: | AN IMAGE IS WORTH 16X16 WORDS: |
| 2 | TRANSFORMERS FOR IMAGE RECOGNITION AT SCALE | TRANSFORMERS FOR IMAGE RECOGNITION AT SCALE |
| 3 | Alexey Dosovitskiy∗,†, Lucas Beyer∗, Alexander Kolesnikov∗, Dirk Weissenborn∗, Xiaohua Zhai∗, Thomas Unterthi… | Alexey Dosovitskiy∗,†, Lucas Beyer∗, Alexander Kolesnikov∗, Dirk Weissenborn∗, Xiaohua Zhai∗, Thomas Unterthi… |
| 4 | ∗equal technical contribution, †equal advising | Google Research, Brain Team {adosovitskiy, neilhoulsby}@google.com |
| 5 | Google Research, Brain Team {adosovitskiy, neilhoulsby}@google.com | ABSTRACT |
| 6 | ABSTRACT | While the Transformer architecture has become the de-facto standard for natural language processing tasks, it… |
| 7 | While the Transformer architecture has become the de-facto standard for natural language processing tasks, it… | 1 INTRODUCTION |
| 8 | 1 INTRODUCTION | Self-attention-based architectures, in particular Transformers (Vaswani et al., 2017), have become the model … |
| 9 | Self-attention-based architectures, in particular Transformers (Vaswani et al., 2017), have become the model … | In computer vision, however, convolutional architectures remain dominant (LeCun et al., 1989; Krizhevsky et a… |
| 10 | In computer vision, however, convolutional architectures remain dominant (LeCun et al., 1989; Krizhevsky et a… | Inspired by the Transformer scaling successes in NLP, we experiment with applying a standard Transformer dire… |
| 11 | Inspired by the Transformer scaling successes in NLP, we experiment with applying a standard Transformer dire… | When trained on mid-sized datasets such as ImageNet without strong regularization, these models yield modest … |
| 12 | When trained on mid-sized datasets such as ImageNet without strong regularization, these models yield modest … | Fine-tuning code and pre-trained models are available at https://github.com/ google-research/vision_transform… |

#### book-think-python — book, LaTeX

Source: https://greenteapress.com/thinkpython2/thinkpython2.pdf · 244 pages · 3786 blocks, 2359 asked (62%)

| # | rules | jev |
|---:|---|---|
| 1 | Think Python | Think Python |
| 2 | How to Think Like a Computer Scientist | How to Think Like a Computer Scientist |
| 3 | 2nd Edition, Version 2.4.0 | 2nd Edition, Version 2.4.0 |
| 4 | Think Python | Think Python |
| 5 | How to Think Like a Computer Scientist | How to Think Like a Computer Scientist |
| 6 | 2nd Edition, Version 2.4.0 | 2nd Edition, Version 2.4.0 |
| 7 | Allen Downey | Allen Downey |
| 8 | Green Tea Press | Green Tea Press |
| 9 | Needham, Massachusetts | Needham, Massachusetts |
| 10 | Copyright © 2015 Allen Downey. | Permission is granted to copy, distribute, and/or modify this document under the terms of the Creative Common… |
| 11 | Green Tea Press 9 Washburn Ave Needham MA 02492 | The original form of this book is LATEX source code. Compiling this LATEX source has the effect of generating… |
| 12 | Permission is granted to copy, distribute, and/or modify this document under the terms of the Creative Common… | The LATEX source for this book is available from http://www.thinkpython.com |

#### ecma-404-json — ECMA/ISO-style standard

Source: https://ecma-international.org/wp-content/uploads/ECMA-404_2nd_edition_december_2017.pdf · 16 pages · 115 blocks, 82 asked (71%)

| # | rules | jev |
|---:|---|---|
| 1 | ECMA-404 | ECMA-404 |
| 2 | 2nd Edition / December 2017 | 2nd Edition / December 2017 |
| 3 | The JSON Data Interchange Syntax | The JSON Data Interchange Syntax |
| 4 | Reference number ECMA-123:2009 | Reference number ECMA-123:2009 |
| 5 | COPYRIGHT PROTECTED DOCUMENT | Introduction |
| 6 | ii © Ecma International 2017 | JSON* is a text syntax that facilitates structured data interchange between all programming languages. JSON i… |
| 7 | Introduction | JSON syntax describes a sequence of Unicode code points. JSON also depends on Unicode in the hex numbers used… |
| 8 | JSON* is a text syntax that facilitates structured data interchange between all programming languages. JSON i… | JSON is agnostic about the semantics of numbers. In any programming language, there can be a variety of numbe… |
| 9 | JSON syntax describes a sequence of Unicode code points. JSON also depends on Unicode in the hex numbers used… | Programming languages vary widely on whether they support objects, and if so, what characteristics and constr… |
| 10 | JSON is agnostic about the semantics of numbers. In any programming language, there can be a variety of numbe… | JSON also provides support for ordered lists of values. All programming languages will have some feature for … |
| 11 | Programming languages vary widely on whether they support objects, and if so, what characteristics and constr… | JSON does not support cyclic graphs, at least not directly. JSON is not indicated for applications requiring … |
| 12 | JSON also provides support for ordered lists of values. All programming languages will have some feature for … | It is expected that other standards will refer to this one, strictly adhering to the JSON syntax, while impos… |

#### letter-berkshire-2023 — shareholder letter, magazine prose

Source: https://www.berkshirehathaway.com/letters/2023ltr.pdf · 16 pages · 136 blocks, 35 asked (26%)

| # | rules | jev |
|---:|---|---|
| 1 | Charlie Munger – The Architect of Berkshire Hathaway | Charlie Munger – The Architect of Berkshire Hathaway |
| 2 | Charlie Munger died on November 28, just 33 days before his 100th birthday. | Charlie Munger died on November 28, just 33 days before his 100th birthday. |
| 3 | Though born and raised in Omaha, he spent 80% of his life domiciled elsewhere. Consequently, it was not until… | Though born and raised in Omaha, he spent 80% of his life domiciled elsewhere. Consequently, it was not until… |
| 4 | Three years later he told me – correctly! – that I had made a dumb decision in buying control of Berkshire. B… | Three years later he told me – correctly! – that I had made a dumb decision in buying control of Berkshire. B… |
| 5 | In what I next relate, bear in mind that Charlie and his family did not have a dime invested in the small inv… | In what I next relate, bear in mind that Charlie and his family did not have a dime invested in the small inv… |
| 6 | Nevertheless, Charlie, in 1965, promptly advised me: “Warren, forget about ever buying another company like B… | Nevertheless, Charlie, in 1965, promptly advised me: “Warren, forget about ever buying another company like B… |
| 7 | Many years later, Charlie became my partner in running Berkshire and, repeatedly, jerked me back to sanity wh… | Many years later, Charlie became my partner in running Berkshire and, repeatedly, jerked me back to sanity wh… |
| 8 | In reality, Charlie was the “architect” of the present Berkshire, and I acted as the “general contractor” to … | In reality, Charlie was the “architect” of the present Berkshire, and I acted as the “general contractor” to … |
| 9 | Charlie never sought to take credit for his role as creator but instead let me take the bows and receive the … | Charlie never sought to take credit for his role as creator but instead let me take the bows and receive the … |
| 10 | In the physical world, great buildings are linked to their architect while those who had poured the concrete … | In the physical world, great buildings are linked to their architect while those who had poured the concrete … |
| 11 | BERKSHIRE HATHAWAY INC. | BERKSHIRE HATHAWAY INC. |
| 12 | To the Shareholders of Berkshire Hathaway Inc.: | To the Shareholders of Berkshire Hathaway Inc.: |

#### rfc8949-cbor — IETF RFC (v3 PDF)

Source: https://www.rfc-editor.org/rfc/rfc8949.pdf · 66 pages · 989 blocks, 564 asked (57%)

| # | rules | jev |
|---:|---|---|
| 1 | [Table 1] | [Table 1] |
| 2 | RFC 8949 Concise Binary Object Representation (CBOR) | RFC 8949 Concise Binary Object Representation (CBOR) |
| 3 | Abstract | Abstract |
| 4 | The Concise Binary Object Representation (CBOR) is a data format whose design goals include the possibility o… | The Concise Binary Object Representation (CBOR) is a data format whose design goals include the possibility o… |
| 5 | This document obsoletes RFC 7049, providing editorial improvements, new details, and errata fixes while keepi… | This document obsoletes RFC 7049, providing editorial improvements, new details, and errata fixes while keepi… |
| 6 | Status of This Memo | Status of This Memo |
| 7 | This is an Internet Standards Track document. | This is an Internet Standards Track document. |
| 8 | This document is a product of the Internet Engineering Task Force (IETF). It represents the consensus of the … | This document is a product of the Internet Engineering Task Force (IETF). It represents the consensus of the … |
| 9 | Information about the current status of this document, any errata, and how to provide feedback on it may be o… | Information about the current status of this document, any errata, and how to provide feedback on it may be o… |
| 10 | Copyright Notice | Copyright Notice |
| 11 | Copyright (c) 2020 IETF Trust and the persons identified as the document authors. All rights reserved. | This document is subject to BCP 78 and the IETF Trust's Legal Provisions Relating to IETF Documents (https://… |
| 12 | This document is subject to BCP 78 and the IETF Trust's Legal Provisions Relating to IETF Documents (https://… | with respect to this document. Code Components extracted from this document must include Simplified BSD Licen… |

#### rfc9111-caching — IETF RFC (v3 PDF)

Source: https://www.rfc-editor.org/rfc/rfc9111.pdf · 35 pages · 637 blocks, 378 asked (59%)

| # | rules | jev |
|---:|---|---|
| 1 | [Table 1] | [Table 1] |
| 2 | RFC 9111 HTTP Caching | RFC 9111 HTTP Caching |
| 3 | Abstract | Abstract |
| 4 | The Hypertext Transfer Protocol (HTTP) is a stateless application-level protocol for distributed, collaborati… | The Hypertext Transfer Protocol (HTTP) is a stateless application-level protocol for distributed, collaborati… |
| 5 | This document obsoletes RFC 7234. | This document obsoletes RFC 7234. |
| 6 | Status of This Memo | Status of This Memo |
| 7 | This is an Internet Standards Track document. | This is an Internet Standards Track document. |
| 8 | This document is a product of the Internet Engineering Task Force (IETF). It represents the consensus of the … | This document is a product of the Internet Engineering Task Force (IETF). It represents the consensus of the … |
| 9 | Information about the current status of this document, any errata, and how to provide feedback on it may be o… | Information about the current status of this document, any errata, and how to provide feedback on it may be o… |
| 10 | Copyright Notice | Copyright Notice |
| 11 | Copyright (c) 2022 IETF Trust and the persons identified as the document authors. All rights reserved. | Copyright (c) 2022 IETF Trust and the persons identified as the document authors. All rights reserved. |
| 12 | This document is subject to BCP 78 and the IETF Trust's Legal Provisions Relating to IETF Documents ( https:/… | This document is subject to BCP 78 and the IETF Trust's Legal Provisions Relating to IETF Documents ( https:/… |

#### rfc9112-http11 — IETF RFC (v3 PDF), long

Source: https://www.rfc-editor.org/rfc/rfc9112.pdf · 46 pages · 760 blocks, 466 asked (61%)

| # | rules | jev |
|---:|---|---|
| 1 | [Table 1] | [Table 1] |
| 2 | RFC 9112 HTTP/1.1 | RFC 9112 HTTP/1.1 |
| 3 | Abstract | Abstract |
| 4 | The Hypertext Transfer Protocol (HTTP) is a stateless application-level protocol for distributed, collaborati… | The Hypertext Transfer Protocol (HTTP) is a stateless application-level protocol for distributed, collaborati… |
| 5 | This document obsoletes portions of RFC 7230. | This document obsoletes portions of RFC 7230. |
| 6 | Status of This Memo | Status of This Memo |
| 7 | This is an Internet Standards Track document. | This is an Internet Standards Track document. |
| 8 | This document is a product of the Internet Engineering Task Force (IETF). It represents the consensus of the … | This document is a product of the Internet Engineering Task Force (IETF). It represents the consensus of the … |
| 9 | Information about the current status of this document, any errata, and how to provide feedback on it may be o… | Information about the current status of this document, any errata, and how to provide feedback on it may be o… |
| 10 | Copyright Notice | Copyright Notice |
| 11 | Copyright (c) 2022 IETF Trust and the persons identified as the document authors. All rights reserved. | This document is subject to BCP 78 and the IETF Trust's Legal Provisions Relating to IETF Documents ( https:/… |
| 12 | This document is subject to BCP 78 and the IETF Trust's Legal Provisions Relating to IETF Documents ( https:/… | Fielding, et al. |

#### scanned-naca-report — scanned report with OCR text layer

Source: https://ntrs.nasa.gov/api/citations/19930091966/downloads/19930091966.pdf · 18 pages · 431 blocks, 338 asked (78%)

| # | rules | jev |
|---:|---|---|
| 1 | REPORT No. 899 | REPORT No. 899 |
| 2 | A GENERAL SMALL-DEFLECTION THEORY FOR FLAT SANDWICH PLATES | A GENERAL SMALL-DEFLECTION THEORY FOR FLAT SANDWICH PLATES |
| 3 | “By | “By |
| 4 | SUMMARY | SUMMARY |
| 5 | .4 smalldejkction theory h dew.?.opedfor the eilm$ic behatior of orthotropic jla=t plutes in which de$ectiom … | .4 smalldejkction theory h dew.?.opedfor the eilm$ic behatior of orthotropic jla=t plutes in which de$ectiom … |
| 6 | The ad-rent of high-speed flight and_the concurrent necessity of maintaining aerodynamically smooth surfaces … | The ad-rent of high-speed flight and_the concurrent necessity of maintaining aerodynamically smooth surfaces … |
| 7 | Because of the low-stiffness core, the sandwich plate will, in general, experience appreciable deflection due… | Because of the low-stiffness core, the sandwich plate will, in general, experience appreciable deflection due… |
| 8 | A generrdsmalIdeflection theory for flat orthotropic plates is therefore developed in which deflections due t… | A generrdsmalIdeflection theory for flat orthotropic plates is therefore developed in which deflections due t… |
| 9 | .— | .— |
| 10 | between the flewral stiffnwwa and Poisson ratios is derived in appendix B. | between the flewral stiffnwwa and Poisson ratios is derived in appendix B. |
| 11 | & is the case with ordinary plate theory, the orthotropic plate theory consists of two parts, each complete i… | & is the case with ordinary plate theory, the orthotropic plate theory consists of two parts, each complete i… |
| 12 | The consideration of deflections due to shear makes necessary the specification of one more boundary conditio… | The consideration of deflections due to shear makes necessary the specification of one more boundary conditio… |

#### slides-cs224n-l1 — lecture slides

Source: https://web.stanford.edu/class/cs224n/slides/cs224n-spr2024-lecture01-wordvecs1.pdf · 40 pages · 253 blocks, 248 asked (98%)

| # | rules | jev |
|---:|---|---|
| 1 | Natural Language Processing with Deep Learning CS224N/Ling284 | Natural Language Processing with Deep Learning CS224N/Ling284 |
| 2 | Christopher Manning Lecture 1: Introduction and Word Vectors | Christopher Manning Lecture 1: Introduction and Word Vectors |
| 3 | Lecture 1: Introduction and Word Vectors | Lecture 1: Introduction and Word Vectors |
| 4 | The course (10 mins) | The course (10 mins) |
| 5 | Human language and word meaning (15 mins) | Human language and word meaning (15 mins) |
| 6 | Word2vec introduction (15 mins) | Word2vec introduction (15 mins) |
| 7 | Word2vec objective function gradients (25 mins) | Word2vec objective function gradients (25 mins) |
| 8 | Optimization basics (5 mins) | Optimization basics (5 mins) |
| 9 | Looking at word vectors (10 mins or less) | Looking at word vectors (10 mins or less) |
| 10 | Key learning today: The (astounding!) result that word meaning can be represented rather well by a (high-dime… | Key learning today: The (astounding!) result that word meaning can be represented rather well by a (high-dime… |
| 11 | Course logistics in brief | Course logistics in brief |
| 12 | Instructor: Christopher Manning | Instructor: Christopher Manning |

#### slides-cs231n-l1 — lecture slides

Source: http://cs231n.stanford.edu/slides/2017/cs231n_2017_lecture1.pdf · 48 pages · 274 blocks, 269 asked (98%)

| # | rules | jev |
|---:|---|---|
| 1 | Lecture 1: Introduction Welcome to CS231n | Lecture 1: Introduction Welcome to CS231n |
| 2 | [Table 1] | [Table 1] |
| 3 | Biology Psychology | Biology Psychology |
| 4 | Neuroscience | Neuroscience |
| 5 | Physics | Physics |
| 6 | Cognitive optics sciences | Cognitive optics sciences |
| 7 | Image | Image |
| 8 | graphics, algorithms, | graphics, algorithms, |
| 9 | Computer | Computer |
| 10 | Computer | Computer |
| 11 | processing | processing |
| 12 | theory,… | theory,… |

#### thesis-berkeley-eecs — PhD thesis / tech report

Source: https://www2.eecs.berkeley.edu/Pubs/TechRpts/2019/EECS-2019-72.pdf · 16 pages · 180 blocks, 93 asked (52%)

| # | rules | jev |
|---:|---|---|
| 1 | Jupyter’s Archive: Searchable Output Histories for Computational Notebooks | Jupyter’s Archive: Searchable Output Histories for Computational Notebooks |
| 2 | Kunal Chaudhary Andrew Head, Ed. Björn Hartmann, Ed. | Kunal Chaudhary Andrew Head, Ed. Björn Hartmann, Ed. |
| 3 | Electrical Engineering and Computer Sciences University of California at Berkeley | Electrical Engineering and Computer Sciences University of California at Berkeley |
| 4 | Technical Report No. UCB/EECS-2019-72 http://www2.eecs.berkeley.edu/Pubs/TechRpts/2019/EECS-2019-72.html | Technical Report No. UCB/EECS-2019-72 http://www2.eecs.berkeley.edu/Pubs/TechRpts/2019/EECS-2019-72.html |
| 5 | May 17, 2019 | Permission to make digital or hard copies of all or part of this work for personal or classroom use is grante… |
| 6 | Copyright © 2019, by the author(s). All rights reserved. | Jupyter’s archive: search through all past outputs generated in a notebook |
| 7 | Permission to make digital or hard copies of all or part of this work for personal or classroom use is grante… | Jupyter’s Archive: Searchable Output Histories for Computational Notebooks |
| 8 | Jupyter’s archive: search through all past outputs generated in a notebook | Kunal Chaudhary |
| 9 | Jupyter’s Archive: Searchable Output Histories for Computational Notebooks | ABSTRACT |
| 10 | Kunal Chaudhary | When using a computational notebook, programmers tend to run, overwrite, and delete cells many times. These a… |
| 11 | ABSTRACT | INTRODUCTION |
| 12 | When using a computational notebook, programmers tend to run, overwrite, and delete cells many times. These a… | When a programmer wants to explore a new data set, implement algorithms, or test different hypotheses, they u… |

#### unicode-ch02 — Unicode Standard chapter

Source: https://www.unicode.org/versions/Unicode15.1.0/ch02.pdf · 63 pages · 645 blocks, 341 asked (53%)

| # | rules | jev |
|---:|---|---|
| 1 | The Unicode® Standard Version 15.0 – Core Specification | The Unicode® Standard Version 15.0 – Core Specification |
| 2 | To learn about the latest version of the Unicode Standard, see https://www.unicode.org/versions/latest/. | To learn about the latest version of the Unicode Standard, see https://www.unicode.org/versions/latest/. |
| 3 | Many of the designations used by manufacturers and sellers to distinguish their products are claimed as trade… | Many of the designations used by manufacturers and sellers to distinguish their products are claimed as trade… |
| 4 | Unicode and the Unicode Logo are registered trademarks of Unicode, Inc., in the United States and other count… | Unicode and the Unicode Logo are registered trademarks of Unicode, Inc., in the United States and other count… |
| 5 | The authors and publisher have taken care in the preparation of this specification, but make no expressed or … | The authors and publisher have taken care in the preparation of this specification, but make no expressed or … |
| 6 | The Unicode Character Database and other files are provided as-is by Unicode, Inc. No claims are made as to f… | The Unicode Character Database and other files are provided as-is by Unicode, Inc. No claims are made as to f… |
| 7 | © 2022 Unicode, Inc. | All rights reserved. This publication is protected by copyright, and permission must be obtained from the pub… |
| 8 | All rights reserved. This publication is protected by copyright, and permission must be obtained from the pub… | The Unicode Standard / the Unicode Consortium; edited by the Unicode Consortium. — Version 15.0. |
| 9 | The Unicode Standard / the Unicode Consortium; edited by the Unicode Consortium. — Version 15.0. | Includes index. |
| 10 | Includes index. | ISBN 978-1-936213-32-0 (https://www.unicode.org/versions/Unicode15.0.0/) |
| 11 | ISBN 978-1-936213-32-0 (https://www.unicode.org/versions/Unicode15.0.0/) | Unicode (Computer character set) I. Unicode Consortium. |
| 12 | Unicode (Computer character set) I. Unicode Consortium. | QA268.U545 2022 |

#### whitepaper-bitcoin — company whitepaper

Source: https://bitcoin.org/bitcoin.pdf · 9 pages · 131 blocks, 91 asked (69%)

| # | rules | jev |
|---:|---|---|
| 1 | Bitcoin: A Peer-to-Peer Electronic Cash System | Bitcoin: A Peer-to-Peer Electronic Cash System |
| 2 | Satoshi Nakamoto satoshin@gmx.com www.bitcoin.org | Satoshi Nakamoto satoshin@gmx.com www.bitcoin.org |
| 3 | Abstract. A purely peer-to-peer version of electronic cash would allow online payments to be sent directly fr… | Abstract. A purely peer-to-peer version of electronic cash would allow online payments to be sent directly fr… |
| 4 | We propose a solution to the double-spending problem using a peer-to-peer network. | We propose a solution to the double-spending problem using a peer-to-peer network. |
| 5 | The network timestamps transactions by hashing them into an ongoing chain of hash-based proof-of-work, formin… | The network timestamps transactions by hashing them into an ongoing chain of hash-based proof-of-work, formin… |
| 6 | Introduction | Introduction |
| 7 | Commerce on the Internet has come to rely almost exclusively on financial institutions serving as trusted thi… | Commerce on the Internet has come to rely almost exclusively on financial institutions serving as trusted thi… |
| 8 | What is needed is an electronic payment system based on cryptographic proof instead of trust, allowing any tw… | What is needed is an electronic payment system based on cryptographic proof instead of trust, allowing any tw… |
| 9 | 1 | Transactions |
| 10 | Transactions | We define an electronic coin as a chain of digital signatures. Each owner transfers the coin to the next by d… |
| 11 | We define an electronic coin as a chain of digital signatures. Each owner transfers the coin to the next by d… | Transaction Transaction Transaction |
| 12 | Transaction Transaction Transaction | Owner 1's Owner 2's Owner 3's Public Key Public Key Public Key |
