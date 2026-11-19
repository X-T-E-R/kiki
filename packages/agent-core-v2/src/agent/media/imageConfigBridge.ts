import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import {
  resolveMaxImageEdgePx,
  resolveReadImageByteBudget,
} from '#/agent/media/image-compress';

import { IMAGE_SECTION, type ImageConfig } from './configSection';

export interface ImageDeliveryLimits {
  readonly maxEdgePx?: number;
  readonly readByteBudget?: number;
}

export interface IImageConfigBridge extends ImageDeliveryLimits {
  readonly _serviceBrand: undefined;
  readonly maxEdgePx: number;
  readonly readByteBudget: number;
}

export const IImageConfigBridge: ServiceIdentifier<IImageConfigBridge> =
  createDecorator<IImageConfigBridge>('imageConfigBridge');

export class ImageConfigBridge extends Disposable implements IImageConfigBridge {
  declare readonly _serviceBrand: undefined;
  private currentMaxEdgePx: number | undefined;
  private currentReadByteBudget: number | undefined;

  constructor(@IConfigService private readonly config: IConfigService) {
    super();
    this.sync(this.config.get<ImageConfig>(IMAGE_SECTION));
    this._register(
      this.config.onDidSectionChange((e) => {
        if (e.domain === IMAGE_SECTION) {
          this.sync(e.value as ImageConfig);
        }
      }),
    );
  }

  get maxEdgePx(): number {
    return resolveMaxImageEdgePx(this.currentMaxEdgePx);
  }

  get readByteBudget(): number {
    return resolveReadImageByteBudget(this.currentReadByteBudget);
  }

  private sync(image: ImageConfig | undefined): void {
    this.currentMaxEdgePx = image?.maxEdgePx;
    this.currentReadByteBudget = image?.readByteBudget;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IImageConfigBridge,
  ImageConfigBridge,
  ScopeActivation.OnScopeCreated,
  'media',
);
