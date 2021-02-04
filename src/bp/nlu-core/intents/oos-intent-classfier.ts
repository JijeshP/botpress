import { MLToolkit } from 'botpress/sdk'
import _ from 'lodash'
import { isPOSAvailable } from 'nlu-core/language/pos-tagger'
import { getStopWordsForLang } from 'nlu-core/language/stopWords'
import {
  featurizeInScopeUtterances,
  featurizeOOSUtterances,
  getUtteranceFeatures
} from 'nlu-core/out-of-scope-featurizer'
import { SMALL_TFIDF } from 'nlu-core/tools/tfidf'
import { isSpace, SPACE } from 'nlu-core/tools/token-utils'
import { Intent, ListEntityModel, PatternEntity, Tools } from 'nlu-core/typings'
import Utterance, { buildUtteranceBatch } from 'nlu-core/utterance/utterance'

import { BuildExactMatchIndex, ExactMatchIndex, findExactIntent } from './exact-matcher'
import { IntentTrainInput, NoneableIntentClassifier, NoneableIntentPredictions } from './intent-classifier'
import { getIntentFeatures } from './intent-featurizer'
import { SvmIntentClassifier } from './svm-intent-classifier'

interface TrainInput extends IntentTrainInput {
  allUtterances: Utterance[]
}

interface Model {
  trainingVocab: string[]
  baseIntentClfModel: string
  oosSvmModel: string | undefined
  exact_match_index: ExactMatchIndex
}

interface Predictors {
  baseIntentClf: SvmIntentClassifier
  oosSvm: MLToolkit.SVM.Predictor | undefined
  trainingVocab: string[]
  exact_match_index: ExactMatchIndex
}

const MIN_NB_UTTERANCES = 3
const NONE_INTENT = 'none'
const NONE_UTTERANCES_BOUNDS = {
  MIN: 20,
  MAX: 200
}

export class OOSIntentClassifier implements NoneableIntentClassifier {
  private model: Model | undefined
  private predictors: Predictors | undefined

  constructor(private tools: Tools) {}

  public async train(trainInput: TrainInput, progress: (p: number) => void): Promise<void> {
    const { languageCode, allUtterances, intents } = trainInput
    const noneIntent = await this._makeNoneIntent(allUtterances, languageCode)

    let combinedProgress = 0
    const scaledProgress = (p: number) => {
      combinedProgress += p / 2
      progress(combinedProgress)
    }

    const [ooScopeModel, inScopeModel] = await Promise.all([
      this._trainOOScopeSvm(trainInput, noneIntent, scaledProgress),
      this._trainInScopeSvm(trainInput, noneIntent, scaledProgress)
    ])

    const exact_match_index = BuildExactMatchIndex(intents)

    this.model = {
      oosSvmModel: ooScopeModel,
      baseIntentClfModel: inScopeModel,
      trainingVocab: this.getVocab(trainInput.allUtterances),
      exact_match_index
    }
  }

  private _makeNoneIntent = async (allUtterances: Utterance[], languageCode: string): Promise<Intent<Utterance>> => {
    const allTokens = _.flatMap(allUtterances, u => u.tokens)

    const vocab = _(allTokens)
      .map(t => t.toString({ lowerCase: true }))
      .uniq()
      .value()

    const lo = this.tools.seededLodashProvider.getSeededLodash()

    const vocabWithDupes = lo(allTokens)
      .map(t => t.value)
      .flattenDeep<string>()
      .value()

    const junkWords = await this.tools.generateSimilarJunkWords(vocab, languageCode)
    const avgTokens = lo.meanBy(allUtterances, x => x.tokens.length)
    const nbOfNoneUtterances = lo.clamp(
      (allUtterances.length * 2) / 3,
      NONE_UTTERANCES_BOUNDS.MIN,
      NONE_UTTERANCES_BOUNDS.MAX
    )
    const stopWords = await getStopWordsForLang(languageCode)
    const vocabWords = lo(allTokens)
      .filter(t => t.tfidf <= SMALL_TFIDF)
      .map(t => t.toString({ lowerCase: true }))
      .uniq()
      .orderBy(t => t)
      .value()

    // If 30% in utterances is a space, language is probably space-separated so we'll join tokens using spaces
    const joinChar = vocabWithDupes.filter(x => isSpace(x)).length >= vocabWithDupes.length * 0.3 ? SPACE : ''

    const vocabUtts = lo.range(0, nbOfNoneUtterances).map(() => {
      const nbWords = Math.round(lo.random(1, avgTokens * 2, false))
      return lo.sampleSize(lo.uniq([...stopWords, ...vocabWords]), nbWords).join(joinChar)
    })

    const junkWordsUtts = lo.range(0, nbOfNoneUtterances).map(() => {
      const nbWords = Math.round(lo.random(1, avgTokens * 2, false))
      return lo.sampleSize(junkWords, nbWords).join(joinChar)
    })

    const mixedUtts = lo.range(0, nbOfNoneUtterances).map(() => {
      const nbWords = Math.round(lo.random(1, avgTokens * 2, false))
      return lo.sampleSize([...junkWords, ...stopWords], nbWords).join(joinChar)
    })

    return <Intent<Utterance>>{
      name: NONE_INTENT,
      slot_definitions: [],
      utterances: await buildUtteranceBatch(
        [...mixedUtts, ...vocabUtts, ...junkWordsUtts, ...stopWords],
        languageCode,
        this.tools
      ),
      contexts: []
    }
  }

  private async _trainOOScopeSvm(
    trainInput: TrainInput,
    noneIntent: Omit<Intent<Utterance>, 'contexts'>,
    progress: (p: number) => void
  ): Promise<string | undefined> {
    const { allUtterances, nluSeed, intents } = trainInput
    const { languageCode } = allUtterances[0]

    const trainingOptions: MLToolkit.SVM.SVMOptions = {
      c: [10], // so there's no grid search
      kernel: 'LINEAR',
      classifier: 'C_SVC',
      seed: nluSeed
    }

    const noneUtts = noneIntent.utterances

    if (!isPOSAvailable(languageCode) || noneUtts.length === 0) {
      progress(1)
      return
    }

    const vocab = this.getVocab(allUtterances)
    const oos_points = featurizeOOSUtterances(noneUtts, vocab, this.tools)

    const in_ctx_scope_points = _.chain(intents)
      .filter(i => i.name !== NONE_INTENT)
      .flatMap(i => featurizeInScopeUtterances(i.utterances, i.name))
      .value()

    const svm = new this.tools.mlToolkit.SVM.Trainer()

    const model = await svm.train([...in_ctx_scope_points, ...oos_points], trainingOptions, progress)
    return model
  }

  private async _trainInScopeSvm(
    trainInput: TrainInput,
    noneIntent: Omit<Intent<Utterance>, 'contexts'>,
    progress: (p: number) => void
  ): Promise<string> {
    const baseIntentClf = new SvmIntentClassifier(this.tools, getIntentFeatures)
    const noneUtts = noneIntent.utterances.filter(u => u.tokens.filter(t => t.isWord).length >= 3)
    const trainableIntents = trainInput.intents.filter(
      i => i.name !== NONE_INTENT && i.utterances.length >= MIN_NB_UTTERANCES
    )
    const nAvgUtts = Math.ceil(_.meanBy(trainableIntents, i => i.utterances.length))

    const lo = this.tools.seededLodashProvider.getSeededLodash()

    const intents: Intent<Utterance>[] = [
      ...trainInput.intents,
      {
        name: NONE_INTENT,
        utterances: lo
          .chain(noneUtts)
          .shuffle()
          .take(nAvgUtts * 2.5) // undescriptible magic n, no sens to extract constant
          .value(),
        contexts: [...trainInput.intents[0].contexts],
        slot_definitions: []
      }
    ]

    await baseIntentClf.train({ ...trainInput, intents }, progress)
    return baseIntentClf.serialize()
  }

  private getVocab(utts: Utterance[]) {
    return _.flatMap(utts, u => u.tokens.map(t => t.toString({ lowerCase: true })))
  }

  public serialize(): string {
    if (!this.model) {
      throw new Error('Intent classifier must be trained before calling serialize')
    }
    return JSON.stringify(this.model)
  }

  public load(serialized: string): void {
    const model: Model = JSON.parse(serialized) // TODO: validate input
    this.predictors = this._makePredictors(model)
    this.model = model
  }

  private _makePredictors(model: Model): Predictors {
    const { oosSvmModel, baseIntentClfModel, trainingVocab, exact_match_index } = model

    const baseIntentClf = new SvmIntentClassifier(this.tools, getIntentFeatures)
    baseIntentClf.load(baseIntentClfModel)

    return {
      oosSvm: oosSvmModel ? new this.tools.mlToolkit.SVM.Predictor(oosSvmModel) : undefined,
      baseIntentClf,
      trainingVocab,
      exact_match_index
    }
  }

  public async predict(utterance: Utterance): Promise<NoneableIntentPredictions> {
    if (!this.predictors) {
      if (!this.model) {
        throw new Error('Intent classifier must be trained before you call predict on it.')
      }

      this.predictors = this._makePredictors(this.model)
    }

    const { oosSvm, baseIntentClf, trainingVocab, exact_match_index } = this.predictors

    const intentPredictions = await baseIntentClf.predict(utterance)

    const exactPred = findExactIntent(exact_match_index, utterance)
    if (exactPred) {
      const idxToRemove = intentPredictions.intents.findIndex(p => p.name === exactPred.name)
      intentPredictions.intents.splice(idxToRemove, 1)
      intentPredictions.intents.unshift(exactPred)
    }

    let oosPrediction = 0
    if (oosSvm) {
      const feats = getUtteranceFeatures(utterance, trainingVocab)
      try {
        const preds = await oosSvm.predict(feats)
        oosPrediction =
          _.chain(preds)
            .filter(p => p.label.startsWith('out'))
            .maxBy(p => p.confidence)
            .value()?.confidence || 0
      } catch (err) {}
    }

    // TODO: proceed to election between none intent and oos, remove none intent and make sure confidences sum to 1.

    return {
      ...intentPredictions,
      oos: oosPrediction
    }
  }
}
