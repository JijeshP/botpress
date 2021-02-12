import { MLToolkit, NLU } from 'botpress/sdk'
import _ from 'lodash'
import Joi, { validate } from 'joi'
import { ListEntityModel, PatternEntity, Tools } from 'nlu-core/typings'
import Utterance from 'nlu-core/utterance/utterance'

import { IntentClassifier, IntentPredictions, IntentTrainInput } from './intent-classifier'
import { ListEntityModelSchema, PatternEntitySchema } from 'nlu-core/entities/schemas'
import { ModelLoadingError } from 'nlu-core/errors'

type Featurizer = (u: Utterance, entities: string[]) => number[]
export interface Model {
  svmModel: string | undefined
  intentNames: string[]
  list_entities: ListEntityModel[]
  pattern_entities: PatternEntity[]
}

interface Predictors {
  svm: MLToolkit.SVM.Predictor | undefined
  intentNames: string[]
  list_entities: ListEntityModel[]
  pattern_entities: PatternEntity[]
}

export const modelSchema = Joi.object()
  .keys({
    svmModel: Joi.string()
      .allow('')
      .optional(),
    intentNames: Joi.array()
      .items(Joi.string())
      .required(),
    list_entities: Joi.array()
      .items(ListEntityModelSchema)
      .required(),
    pattern_entities: Joi.array()
      .items(PatternEntitySchema)
      .required()
  })
  .required()

export class SvmIntentClassifier implements IntentClassifier {
  private static _name = 'SVM Intent Classifier'

  private model: Model | undefined
  private predictors: Predictors | undefined

  constructor(private tools: Tools, private featurizer: Featurizer, private logger?: NLU.Logger) {}

  async train(input: IntentTrainInput, progress: (p: number) => void): Promise<void> {
    const { intents, nluSeed, list_entities, pattern_entities } = input

    const entitiesName = this._getEntitiesName(list_entities, pattern_entities)

    const points = _(intents)
      .flatMap(({ utterances, name }) => {
        return utterances.map(utt => ({
          label: name,
          coordinates: this.featurizer(utt, entitiesName)
        }))
      })
      .filter(x => x.coordinates.filter(isNaN).length === 0)
      .value()

    const classCount = _.uniqBy(points, p => p.label).length
    if (points.length === 0 || classCount <= 1) {
      this.logger?.debug('No SVM to train because there is less than two classes.')
      this.model = {
        svmModel: undefined,
        intentNames: intents.map(i => i.name),
        list_entities,
        pattern_entities
      }
      progress(1)
      return
    }

    const svm = new this.tools.mlToolkit.SVM.Trainer()

    const seed = nluSeed
    const svmModel = await svm.train(points, { kernel: 'LINEAR', classifier: 'C_SVC', seed }, progress)

    this.model = {
      svmModel,
      intentNames: intents.map(i => i.name),
      list_entities,
      pattern_entities
    }

    progress(1)
  }

  serialize(): string {
    if (!this.model) {
      throw new Error(`${SvmIntentClassifier._name} must be trained before calling serialize.`)
    }
    return JSON.stringify(this.model)
  }

  async load(serialized: string): Promise<void> {
    try {
      const raw = JSON.parse(serialized)
      const model: Model = await validate(raw, modelSchema)
      this.predictors = this._makePredictors(model)
      this.model = model
    } catch (err) {
      throw new ModelLoadingError(SvmIntentClassifier._name, err)
    }
  }

  private _makePredictors(model: Model): Predictors {
    const { svmModel, intentNames, list_entities, pattern_entities } = model
    return {
      svm: svmModel ? new this.tools.mlToolkit.SVM.Predictor(svmModel) : undefined,
      intentNames,
      list_entities,
      pattern_entities
    }
  }

  async predict(utterance: Utterance): Promise<IntentPredictions> {
    if (!this.predictors) {
      if (!this.model) {
        throw new Error(`${SvmIntentClassifier._name} must be trained before calling predict.`)
      }

      this.predictors = this._makePredictors(this.model)
    }

    const { svm, intentNames, list_entities, pattern_entities } = this.predictors
    if (!svm) {
      if (intentNames.length <= 0) {
        return {
          intents: []
        }
      }

      const intent = intentNames[0]
      return {
        intents: [{ name: intent, confidence: 1, extractor: 'svm-classifier' }]
      }
    }

    const entitiesName = this._getEntitiesName(list_entities, pattern_entities)
    const features = this.featurizer(utterance, entitiesName)
    const preds = await svm.predict(features)

    return {
      intents: preds.map(({ label, confidence }) => ({ name: label, confidence, extractor: 'svm-classifier' }))
    }
  }

  private _getEntitiesName(list_entities: ListEntityModel[], pattern_entities: PatternEntity[]) {
    return [...list_entities.map(e => e.entityName), ...pattern_entities.map(e => e.name)]
  }
}
