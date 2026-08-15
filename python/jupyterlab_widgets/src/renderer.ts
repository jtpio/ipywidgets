// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { PromiseDelegate } from '@lumino/coreutils';

import { IDisposable } from '@lumino/disposable';

import { Panel, Widget as LuminoWidget } from '@lumino/widgets';

import { IRenderMime } from '@jupyterlab/rendermime-interfaces';

import { LabWidgetManager } from './manager';
import { DOMWidgetModel } from '@jupyter-widgets/base';

/**
 * A renderer for widgets.
 */
export class WidgetRenderer
  extends Panel
  implements IRenderMime.IRenderer, IDisposable
{
  constructor(
    options: IRenderMime.IRendererOptions,
    manager?: LabWidgetManager
  ) {
    super();
    this.mimeType = options.mimeType;
    if (manager) {
      this.manager = manager;
    }
  }

  /**
   * How long (in ms) to wait for a widget model before showing "model not
   * found". The renderer keeps waiting, and renders a model that registers
   * later.
   */
  static modelTimeout = 5000;

  /**
   * The widget manager.
   */
  set manager(value: LabWidgetManager) {
    this._manager.resolve(value);
  }

  async renderModel(model: IRenderMime.IMimeModel): Promise<void> {
    const source: any = model.data[this.mimeType];

    // Supersede any earlier render that still waits for its model.
    const epoch = ++this._renderEpoch;

    // Let's be optimistic, and hope the widget state will come later.
    this.node.textContent = 'Loading widget...';

    const manager = await this._manager.promise;
    // If there is no model id, the view was removed, so hide the node.
    if (source.model_id === '') {
      this.hide();
      return Promise.resolve();
    }

    // The comm_open message that creates the model can arrive after the
    // output is rendered, so show the error but keep waiting for the model.
    const timer = setTimeout(() => {
      if (!this._isStale(epoch)) {
        this._showModelNotFound();
      }
    }, WidgetRenderer.modelTimeout);

    let wModel: DOMWidgetModel;
    try {
      // Presume we have a DOMWidgetModel. Should we check for sure?
      wModel = (await manager.get_model_when_available(
        source.model_id
      )) as DOMWidgetModel;
    } catch (err) {
      if (!this._isStale(epoch)) {
        this._showModelNotFound();
        console.error(err);
      }
      return;
    } finally {
      clearTimeout(timer);
    }

    let widget: LuminoWidget;
    try {
      const view = await manager.create_view(wModel);
      widget = view.luminoWidget || view.pWidget;
    } catch (err) {
      if (!this._isStale(epoch)) {
        this.node.textContent = 'Error displaying widget';
        this.addClass('jupyter-widgets');
        console.error(err);
      }
      return;
    }
    if (this._isStale(epoch)) {
      widget.dispose();
      return;
    }

    // Clear any previous error or loading message.
    this.removeClass('jupyter-widgets');
    this.node.textContent = '';
    this.addWidget(widget);

    // When the widget is disposed, hide this container and make sure we
    // change the output model to reflect the view was closed.
    widget.disposed.connect(() => {
      this.hide();
      source.model_id = '';
    });
  }

  /**
   * Dispose the resources held by the manager.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._manager = null!;
    super.dispose();
  }

  /**
   * Whether a newer render superseded this one, or the renderer went away.
   */
  private _isStale(epoch: number): boolean {
    return this.isDisposed || epoch !== this._renderEpoch;
  }

  private _showModelNotFound(): void {
    this.node.textContent = 'Error displaying widget: model not found';
    this.addClass('jupyter-widgets');
  }

  /**
   * The mimetype being rendered.
   */
  readonly mimeType: string;
  private _manager = new PromiseDelegate<LabWidgetManager>();
  private _renderEpoch = 0;
}
