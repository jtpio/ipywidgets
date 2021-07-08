// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { ISettingRegistry } from '@jupyterlab/settingregistry';

import * as nbformat from '@jupyterlab/nbformat';

import { IConsoleTracker, CodeConsole } from '@jupyterlab/console';

import { DocumentRegistry } from '@jupyterlab/docregistry';

import {
  INotebookModel,
  INotebookTracker,
  Notebook,
  NotebookPanel,
} from '@jupyterlab/notebook';

import {
  JupyterFrontEndPlugin,
  JupyterFrontEnd,
} from '@jupyterlab/application';

import { IMainMenu } from '@jupyterlab/mainmenu';

import { IRenderMimeRegistry } from '@jupyterlab/rendermime';

import { ILoggerRegistry, LogLevel } from '@jupyterlab/logconsole';

import { CodeCell } from '@jupyterlab/cells';

import { toArray, filter } from '@lumino/algorithm';

import { DisposableDelegate } from '@lumino/disposable';

import { WidgetRenderer } from './renderer';

import {
  WidgetManager,
  WIDGET_VIEW_MIMETYPE,
  KernelWidgetManager,
} from './manager';

import { OutputModel, OutputView, OUTPUT_WIDGET_VERSION } from './output';

import * as base from '@jupyter-widgets/base';

// We import only the version from the specific module in controls so that the
// controls code can be split and dynamically loaded in webpack.
import { JUPYTER_CONTROLS_VERSION } from '@jupyter-widgets/controls/lib/version';

import '@jupyter-widgets/base/css/index.css';
import '@jupyter-widgets/controls/css/widgets-base.css';
import { KernelMessage } from '@jupyterlab/services';

const WIDGET_REGISTRY: base.IWidgetRegistryData[] = [];

/**
 * The cached settings.
 */
const SETTINGS: WidgetManager.Settings = { saveState: false };

/**
 * Iterate through all widget renderers in a notebook.
 */
function* notebookWidgetRenderers(
  nb: Notebook
): Generator<WidgetRenderer, void, unknown> {
  for (const cell of nb.widgets) {
    if (cell.model.type === 'code') {
      for (const codecell of (cell as CodeCell).outputArea.widgets) {
        for (const output of toArray(codecell.children())) {
          if (output instanceof WidgetRenderer) {
            yield output;
          }
        }
      }
    }
  }
}

/**
 * Iterate through all widget renderers in a console.
 */
function* consoleWidgetRenderers(
  console: CodeConsole
): Generator<WidgetRenderer, void, unknown> {
  for (const cell of toArray(console.cells)) {
    if (cell.model.type === 'code') {
      for (const codecell of (cell as unknown as CodeCell).outputArea.widgets) {
        for (const output of toArray(codecell.children())) {
          if (output instanceof WidgetRenderer) {
            yield output;
          }
        }
      }
    }
  }
}

/**
 * Iterate through all matching linked output views
 */
function* outputViews(
  app: JupyterFrontEnd,
  path: string
): Generator<WidgetRenderer, void, unknown> {
  const linkedViews = filter(
    app.shell.widgets(),
    (w) => w.id.startsWith('LinkedOutputView-') && (w as any).path === path
  );
  for (const view of toArray(linkedViews)) {
    for (const outputs of toArray(view.children())) {
      for (const output of toArray(outputs.children())) {
        if (output instanceof WidgetRenderer) {
          yield output;
        }
      }
    }
  }
}

function* chain<T>(
  ...args: IterableIterator<T>[]
): Generator<T, void, undefined> {
  for (const it of args) {
    yield* it;
  }
}

export function registerWidgetManager(
  context: DocumentRegistry.IContext<INotebookModel>,
  rendermime: IRenderMimeRegistry,
  renderers: IterableIterator<WidgetRenderer>
): DisposableDelegate {
  let wManager = Private.widgetManagerProperty.get(context.sessionContext.path);
  if (!wManager) {
    wManager = new WidgetManager(context, rendermime, SETTINGS);
    WIDGET_REGISTRY.forEach((data) => wManager!.register(data));
    Private.widgetManagerProperty.set(context.sessionContext.path, wManager);
  }

  for (const r of renderers) {
    r.manager = wManager;
  }

  // Replace the placeholder widget renderer with one bound to this widget
  // manager.
  rendermime.removeMimeType(WIDGET_VIEW_MIMETYPE);
  rendermime.addFactory(
    {
      safe: false,
      mimeTypes: [WIDGET_VIEW_MIMETYPE],
      createRenderer: (options) => new WidgetRenderer(options, wManager),
    },
    0
  );

  return new DisposableDelegate(() => {
    if (rendermime) {
      rendermime.removeMimeType(WIDGET_VIEW_MIMETYPE);
    }
    wManager!.dispose();
  });
}

export function registerConsoleWidgetManager(
  console: CodeConsole,
  rendermime: IRenderMimeRegistry,
  renderers: IterableIterator<WidgetRenderer>
): DisposableDelegate {
  let wManager = Private.widgetManagerProperty.get(console.sessionContext.path);
  if (!wManager) {
    wManager = new KernelWidgetManager(
      console.sessionContext.session?.kernel!,
      rendermime
    );
    WIDGET_REGISTRY.forEach((data) => wManager!.register(data));
    Private.widgetManagerProperty.set(console.sessionContext.path, wManager);
  }

  for (const r of renderers) {
    r.manager = wManager;
  }

  // Replace the placeholder widget renderer with one bound to this widget
  // manager.
  rendermime.removeMimeType(WIDGET_VIEW_MIMETYPE);
  rendermime.addFactory(
    {
      safe: false,
      mimeTypes: [WIDGET_VIEW_MIMETYPE],
      createRenderer: (options) => new WidgetRenderer(options, wManager),
    },
    0
  );

  return new DisposableDelegate(() => {
    if (rendermime) {
      rendermime.removeMimeType(WIDGET_VIEW_MIMETYPE);
    }
    wManager!.dispose();
  });
}

/**
 * The widget manager provider.
 */
const plugin: JupyterFrontEndPlugin<base.IJupyterWidgetRegistry> = {
  id: '@jupyter-widgets/jupyterlab-manager:plugin',
  requires: [IRenderMimeRegistry],
  optional: [
    INotebookTracker,
    IConsoleTracker,
    ISettingRegistry,
    IMainMenu,
    ILoggerRegistry,
  ],
  provides: base.IJupyterWidgetRegistry,
  activate: activateWidgetExtension,
  autoStart: true,
};

export default plugin;

function updateSettings(settings: ISettingRegistry.ISettings): void {
  SETTINGS.saveState = settings.get('saveState').composite as boolean;
}

/**
 * Activate the widget extension.
 */
function activateWidgetExtension(
  app: JupyterFrontEnd,
  rendermime: IRenderMimeRegistry,
  tracker: INotebookTracker | null,
  consoleTracker: IConsoleTracker | null,
  settingRegistry: ISettingRegistry | null,
  menu: IMainMenu | null,
  loggerRegistry: ILoggerRegistry | null
): base.IJupyterWidgetRegistry {
  const { commands } = app;

  const bindUnhandledIOPubMessageSignal = (nb: NotebookPanel): void => {
    if (!loggerRegistry) {
      return;
    }

    const wManager = Private.widgetManagerProperty.get(
      nb.context.sessionContext.path
    );
    if (wManager) {
      wManager.onUnhandledIOPubMessage.connect(
        (
          sender: WidgetManager | KernelWidgetManager,
          msg: KernelMessage.IIOPubMessage
        ) => {
          const logger = loggerRegistry.getLogger(nb.context.path);
          let level: LogLevel = 'warning';
          if (
            KernelMessage.isErrorMsg(msg) ||
            (KernelMessage.isStreamMsg(msg) && msg.content.name === 'stderr')
          ) {
            level = 'error';
          }
          const data: nbformat.IOutput = {
            ...msg.content,
            output_type: msg.header.msg_type,
          };
          logger.rendermime = nb.content.rendermime;
          logger.log({ type: 'output', data, level });
        }
      );
    }
  };
  if (settingRegistry !== null) {
    settingRegistry
      .load(plugin.id)
      .then((settings: ISettingRegistry.ISettings) => {
        settings.changed.connect(updateSettings);
        updateSettings(settings);
      })
      .catch((reason: Error) => {
        console.error(reason.message);
      });
  }

  // Add a placeholder widget renderer.
  rendermime.addFactory(
    {
      safe: false,
      mimeTypes: [WIDGET_VIEW_MIMETYPE],
      createRenderer: (options) => new WidgetRenderer(options),
    },
    0
  );

  if (tracker !== null) {
    tracker.forEach((panel) => {
      registerWidgetManager(
        panel.context,
        panel.content.rendermime,
        chain(
          notebookWidgetRenderers(panel.content),
          outputViews(app, panel.context.path)
        )
      );

      bindUnhandledIOPubMessageSignal(panel);
    });
    tracker.widgetAdded.connect((sender, panel) => {
      registerWidgetManager(
        panel.context,
        panel.content.rendermime,
        chain(
          notebookWidgetRenderers(panel.content),
          outputViews(app, panel.context.path)
        )
      );

      bindUnhandledIOPubMessageSignal(panel);
    });
  }

  if (consoleTracker !== null) {
    consoleTracker.forEach(async (panel) => {
      await panel.sessionContext.ready;
      registerConsoleWidgetManager(
        panel.console,
        panel.console.rendermime,
        chain(consoleWidgetRenderers(panel.console))
      );
    });
    consoleTracker.widgetAdded.connect(async (sender, panel) => {
      await panel.sessionContext.ready;
      registerConsoleWidgetManager(
        panel.console,
        panel.console.rendermime,
        chain(consoleWidgetRenderers(panel.console))
      );
    });
  }
  if (settingRegistry !== null) {
    // Add a command for automatically saving (jupyter-)widget state.
    commands.addCommand('@jupyter-widgets/jupyterlab-manager:saveWidgetState', {
      label: 'Save Widget State Automatically',
      execute: (args) => {
        return settingRegistry
          .set(plugin.id, 'saveState', !SETTINGS.saveState)
          .catch((reason: Error) => {
            console.error(`Failed to set ${plugin.id}: ${reason.message}`);
          });
      },
      isToggled: () => SETTINGS.saveState,
    });
  }

  if (menu) {
    menu.settingsMenu.addGroup([
      { command: '@jupyter-widgets/jupyterlab-manager:saveWidgetState' },
    ]);
  }

  WIDGET_REGISTRY.push({
    name: '@jupyter-widgets/base',
    version: base.JUPYTER_WIDGETS_VERSION,
    exports: {
      WidgetModel: base.WidgetModel,
      WidgetView: base.WidgetView,
      DOMWidgetView: base.DOMWidgetView,
      DOMWidgetModel: base.DOMWidgetModel,
      LayoutModel: base.LayoutModel,
      LayoutView: base.LayoutView,
      StyleModel: base.StyleModel,
      StyleView: base.StyleView,
    },
  });

  WIDGET_REGISTRY.push({
    name: '@jupyter-widgets/controls',
    version: JUPYTER_CONTROLS_VERSION,
    exports: () => {
      return new Promise((resolve, reject) => {
        (require as any).ensure(
          ['@jupyter-widgets/controls'],
          (require: NodeRequire) => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            resolve(require('@jupyter-widgets/controls'));
          },
          (err: any) => {
            reject(err);
          },
          '@jupyter-widgets/controls'
        );
      });
    },
  });

  WIDGET_REGISTRY.push({
    name: '@jupyter-widgets/output',
    version: OUTPUT_WIDGET_VERSION,
    exports: { OutputModel, OutputView },
  });

  return {
    registerWidget(data: base.IWidgetRegistryData): void {
      WIDGET_REGISTRY.push(data);
    },
  };
}

namespace Private {
  /**
   * A private attached property for a widget manager.
   */
  export const widgetManagerProperty = new Map<
    string,
    WidgetManager | KernelWidgetManager | undefined
  >();
}
