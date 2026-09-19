import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const imageFormatConversionFlag: FlagDefinitionInput = {
  id: 'image_format_conversion',
  title: 'Image format conversion',
  description: 'Convert unsupported image formats before model requests.',
  env: 'KIKI_EXPERIMENTAL_IMAGE_FORMAT_CONVERSION',
  default: false,
  surface: 'both',
};

registerFlagDefinition(imageFormatConversionFlag);
