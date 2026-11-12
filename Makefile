.PHONY: prepare build typecheck lint lint-fix lint-pkg sherif test test-watch test-coverage clean changeset version publish release dev

## Setup

prepare:
	pnpm install

## Build

build:
	pnpm run build

## Quality

typecheck:
	pnpm run typecheck

lint:
	pnpm run lint

lint-fix:
	pnpm run lint:fix

sherif:
	pnpm run sherif

lint-pkg:
	pnpm run lint:pkg

## Test

test:
	pnpm run test

test-watch:
	pnpm run test:watch

test-coverage:
	pnpm run test:coverage

## Clean

clean:
	pnpm run clean

## Release

changeset:
	pnpm run changeset

version:
	pnpm run version

publish:
	pnpm run publish

release: version publish

## Development

dev:
	pnpm run dev:cli
