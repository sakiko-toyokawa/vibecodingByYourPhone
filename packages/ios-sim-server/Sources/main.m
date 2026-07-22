#import <AppKit/AppKit.h>
#import <CoreFoundation/CoreFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <VideoToolbox/VideoToolbox.h>
#import <dlfcn.h>
#import <mach/mach_time.h>
#import <malloc/malloc.h>
#import <math.h>
#import <objc/message.h>
#import <unistd.h>

typedef NS_ENUM(uint8_t, MessageType) {
  MessageTypeFrameRequest = 0x01,
  MessageTypeFrameResponse = 0x02,
  MessageTypeControl = 0x03,
};

typedef NS_ENUM(uint32_t, IndigoButtonEventType) {
  IndigoButtonEventTypeDown = 0x1,
  IndigoButtonEventTypeUp = 0x2,
};

typedef NS_ENUM(uint32_t, IndigoButtonTarget) {
  IndigoButtonTargetTouchScreen = 0x32,
  IndigoButtonTargetHardware = 0x33,
};

typedef NS_ENUM(uint32_t, IndigoButtonSource) {
  IndigoButtonSourceApplePay = 0x1f4,
  IndigoButtonSourceHome = 0x0,
  IndigoButtonSourceLock = 0x1,
  IndigoButtonSourceSide = 0xbb8,
  IndigoButtonSourceSiri = 0x400002,
};

#pragma pack(push, 4)
typedef struct {
  unsigned int msgh_bits;
  unsigned int msgh_size;
  unsigned int msgh_remote_port;
  unsigned int msgh_local_port;
  unsigned int msgh_voucher_port;
  int msgh_id;
} MachMessageHeader;

typedef struct {
  unsigned int field1;
  unsigned int field2;
  unsigned int field3;
  double xRatio;
  double yRatio;
  double field6;
  double field7;
  double field8;
  unsigned int field9;
  unsigned int field10;
  unsigned int field11;
  unsigned int field12;
  unsigned int field13;
  double field14;
  double field15;
  double field16;
  double field17;
  double field18;
} IndigoTouch;

typedef struct {
  unsigned int eventSource;
  unsigned int eventType;
  unsigned int eventTarget;
  unsigned int keyCode;
  unsigned int field5;
} IndigoButton;

typedef union {
  IndigoTouch touch;
  IndigoButton button;
} IndigoEvent;

typedef struct {
  unsigned int field1;
  unsigned long long timestamp;
  unsigned int field3;
  IndigoEvent event;
} IndigoPayload;

typedef struct {
  MachMessageHeader header;
  unsigned int innerSize;
  unsigned char eventType;
  IndigoPayload payload;
} IndigoMessage;
#pragma pack(pop)

typedef IndigoMessage *(*IndigoButtonMessageFn)(int keyCode, int op, int target);
typedef IndigoMessage *(*IndigoKeyboardMessageFn)(NSEvent *event);
typedef IndigoMessage *(*IndigoMouseMessageFn)(CGPoint *point0, CGPoint *point1, int target, int eventType, BOOL something);

typedef struct {
  id hidClient;
  IndigoButtonMessageFn buttonFn;
  IndigoKeyboardMessageFn keyboardFn;
  IndigoMouseMessageFn mouseFn;
} HIDContext;

static id SendId(id target, const char *selectorName) {
  SEL sel = sel_registerName(selectorName);
  return ((id(*)(id, SEL))objc_msgSend)(target, sel);
}

static id SendIdArg(id target, const char *selectorName, id arg) {
  SEL sel = sel_registerName(selectorName);
  return ((id(*)(id, SEL, id))objc_msgSend)(target, sel, arg);
}

static id SendIdArgArg(id target, const char *selectorName, id arg1, id arg2) {
  SEL sel = sel_registerName(selectorName);
  return ((id(*)(id, SEL, id, id))objc_msgSend)(target, sel, arg1, arg2);
}

static id SendIdArgError(id target, const char *selectorName, id arg, NSError **error) {
  SEL sel = sel_registerName(selectorName);
  return ((id(*)(id, SEL, id, NSError **))objc_msgSend)(target, sel, arg, error);
}

static BOOL SendBoolArgError(id target, const char *selectorName, id arg, NSError **error) {
  SEL sel = sel_registerName(selectorName);
  return ((BOOL(*)(id, SEL, id, NSError **))objc_msgSend)(target, sel, arg, error);
}

static void SendMessageFreeQueueCompletion(id target,
                                           const char *selectorName,
                                           IndigoMessage *message,
                                           BOOL freeWhenDone,
                                           id queue,
                                           id completion) {
  SEL sel = sel_registerName(selectorName);
  ((void(*)(id, SEL, IndigoMessage *, BOOL, id, id))objc_msgSend)(
      target, sel, message, freeWhenDone, queue, completion);
}

static NSString *DescribeObject(id obj) {
  if (!obj) return @"<nil>";
  @try {
    return [obj description];
  } @catch (NSException *exception) {
    return [NSString stringWithFormat:@"<description threw %@>", exception.name];
  }
}

static id ValueForKeySafe(id obj, NSString *key) {
  if (!obj) return nil;
  @try {
    return [obj valueForKey:key];
  } @catch (NSException *exception) {
    return nil;
  }
}

static BOOL WriteAll(int fd, const void *buffer, size_t length, NSError **error) {
  const uint8_t *cursor = (const uint8_t *)buffer;
  size_t remaining = length;
  while (remaining > 0) {
    ssize_t written = write(fd, cursor, remaining);
    if (written < 0) {
      if (error) {
        *error = [NSError errorWithDomain:NSPOSIXErrorDomain code:errno userInfo:nil];
      }
      return NO;
    }
    cursor += written;
    remaining -= (size_t)written;
  }
  return YES;
}

static BOOL ReadExact(int fd, void *buffer, size_t length, NSError **error) {
  uint8_t *cursor = (uint8_t *)buffer;
  size_t remaining = length;
  while (remaining > 0) {
    ssize_t n = read(fd, cursor, remaining);
    if (n == 0) {
      if (error) {
        *error = [NSError errorWithDomain:NSPOSIXErrorDomain code:0 userInfo:@{
          NSLocalizedDescriptionKey: @"EOF",
        }];
      }
      return NO;
    }
    if (n < 0) {
      if (error) {
        *error = [NSError errorWithDomain:NSPOSIXErrorDomain code:errno userInfo:nil];
      }
      return NO;
    }
    cursor += n;
    remaining -= (size_t)n;
  }
  return YES;
}

static BOOL WriteHandshake(int fd, int width, int height, NSError **error) {
  uint8_t handshake[4];
  handshake[0] = (uint8_t)(width & 0xff);
  handshake[1] = (uint8_t)((width >> 8) & 0xff);
  handshake[2] = (uint8_t)(height & 0xff);
  handshake[3] = (uint8_t)((height >> 8) & 0xff);
  return WriteAll(fd, handshake, sizeof(handshake), error);
}

static BOOL WriteLengthPrefixedMessage(int fd, uint8_t type, NSData *payload, NSError **error) {
  uint32_t payloadLength = (uint32_t)payload.length;
  uint8_t header[5];
  header[0] = type;
  header[1] = (uint8_t)(payloadLength & 0xff);
  header[2] = (uint8_t)((payloadLength >> 8) & 0xff);
  header[3] = (uint8_t)((payloadLength >> 16) & 0xff);
  header[4] = (uint8_t)((payloadLength >> 24) & 0xff);
  if (!WriteAll(fd, header, sizeof(header), error)) {
    return NO;
  }
  if (payloadLength == 0) {
    return YES;
  }
  return WriteAll(fd, payload.bytes, payload.length, error);
}

static BOOL ReadLengthPrefixedPayload(int fd, NSMutableData **payloadOut, NSError **error) {
  uint8_t lengthBytes[4];
  if (!ReadExact(fd, lengthBytes, sizeof(lengthBytes), error)) {
    return NO;
  }
  uint32_t payloadLength = (uint32_t)lengthBytes[0] |
                           ((uint32_t)lengthBytes[1] << 8) |
                           ((uint32_t)lengthBytes[2] << 16) |
                           ((uint32_t)lengthBytes[3] << 24);
  NSMutableData *payload = [NSMutableData dataWithLength:payloadLength];
  if (payloadLength > 0 && !ReadExact(fd, payload.mutableBytes, payloadLength, error)) {
    return NO;
  }
  if (payloadOut) *payloadOut = payload;
  return YES;
}

typedef struct {
  NSData *jpegData;
  NSError *error;
} JPEGEncodeResult;

typedef struct {
  VTCompressionSessionRef session;
  int width;
  int height;
  JPEGEncodeResult *activeResult;
} JPEGEncoder;

static void CompressionOutputCallback(void *outputCallbackRefCon,
                                      void *sourceFrameRefCon,
                                      OSStatus status,
                                      VTEncodeInfoFlags infoFlags,
                                      CMSampleBufferRef sampleBuffer) {
  (void)sourceFrameRefCon;
  (void)infoFlags;

  JPEGEncoder *encoder = (JPEGEncoder *)outputCallbackRefCon;
  JPEGEncodeResult *result = encoder ? encoder->activeResult : NULL;
  if (result == NULL) {
    return;
  }
  if (status != noErr) {
    result->error = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:nil];
    return;
  }
  if (sampleBuffer == NULL) {
    result->error = [NSError errorWithDomain:@"ios-sim-server"
                                        code:1
                                    userInfo:@{NSLocalizedDescriptionKey: @"VideoToolbox returned no sample buffer"}];
    return;
  }

  CMBlockBufferRef blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer);
  if (blockBuffer == NULL) {
    result->error = [NSError errorWithDomain:@"ios-sim-server"
                                        code:2
                                    userInfo:@{NSLocalizedDescriptionKey: @"Encoded sample buffer has no data buffer"}];
    return;
  }

  size_t length = CMBlockBufferGetDataLength(blockBuffer);
  NSMutableData *data = [NSMutableData dataWithLength:length];
  OSStatus copyStatus = CMBlockBufferCopyDataBytes(blockBuffer, 0, length, data.mutableBytes);
  if (copyStatus != noErr) {
    result->error = [NSError errorWithDomain:NSOSStatusErrorDomain code:copyStatus userInfo:nil];
    return;
  }

  result->jpegData = [data copy];
}

static BOOL CreateJPEGEncoder(int width, int height, JPEGEncoder *encoder, NSError **error) {
  if (!encoder) return NO;
  encoder->session = NULL;
  encoder->width = width;
  encoder->height = height;
  encoder->activeResult = NULL;

  VTCompressionSessionRef session = NULL;
  OSStatus status = VTCompressionSessionCreate(
      kCFAllocatorDefault,
      width,
      height,
      kCMVideoCodecType_JPEG,
      NULL,
      NULL,
      NULL,
      CompressionOutputCallback,
      encoder,
      &session);
  if (status != noErr) {
    if (error) *error = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:nil];
    return NO;
  }

  VTSessionSetProperty(session, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
  VTSessionSetProperty(session, kVTCompressionPropertyKey_Quality, (__bridge CFTypeRef)@(0.7));

  encoder->session = session;
  return YES;
}

static void DestroyJPEGEncoder(JPEGEncoder *encoder) {
  if (!encoder || !encoder->session) return;
  VTCompressionSessionInvalidate(encoder->session);
  CFRelease(encoder->session);
  encoder->session = NULL;
}

static NSData *EncodeJPEG(JPEGEncoder *encoder, CVPixelBufferRef pixelBuffer, NSError **error) {
  if (!encoder || !encoder->session) {
    if (error) {
      *error = [NSError errorWithDomain:@"ios-sim-server"
                                   code:10
                               userInfo:@{NSLocalizedDescriptionKey: @"JPEG encoder is not initialized"}];
    }
    return nil;
  }

  JPEGEncodeResult result = {0};
  encoder->activeResult = &result;

  CMTime pts = CMTimeMake(0, 1000);
  OSStatus status =
      VTCompressionSessionEncodeFrame(encoder->session, pixelBuffer, pts, kCMTimeInvalid, NULL, NULL, NULL);
  if (status == noErr) {
    status = VTCompressionSessionCompleteFrames(encoder->session, kCMTimeInvalid);
  }
  encoder->activeResult = NULL;

  if (status != noErr) {
    if (error) *error = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:nil];
    return nil;
  }

  if (result.error != nil) {
    if (error) *error = result.error;
    return nil;
  }
  if (result.jpegData == nil) {
    if (error) {
      *error = [NSError errorWithDomain:@"ios-sim-server"
                                   code:3
                               userInfo:@{NSLocalizedDescriptionKey: @"No JPEG bytes returned"}];
    }
    return nil;
  }
  return result.jpegData;
}

static id FindBootedDevice(NSString *udid) {
  Class simServiceContextClass = NSClassFromString(@"SimServiceContext");
  Class simDeviceSetClass = NSClassFromString(@"SimDeviceSet");
  if (!simServiceContextClass || !simDeviceSetClass) {
    return nil;
  }

  NSError *ctxError = nil;
  NSString *developerDir = @"/Applications/Xcode.app/Contents/Developer";
  id serviceContext = nil;
  if ([simServiceContextClass respondsToSelector:sel_registerName("sharedServiceContextForDeveloperDir:error:")]) {
    serviceContext =
        SendIdArgError(simServiceContextClass, "sharedServiceContextForDeveloperDir:error:", developerDir, &ctxError);
  } else if ([simServiceContextClass respondsToSelector:sel_registerName("serviceContextForDeveloperDir:error:")]) {
    serviceContext =
        SendIdArgError(simServiceContextClass, "serviceContextForDeveloperDir:error:", developerDir, &ctxError);
  }
  if (!serviceContext || ctxError != nil) {
    fprintf(stderr, "Failed to create SimServiceContext: %s\n", DescribeObject(ctxError).UTF8String);
    return nil;
  }

  id defaultSetPath = SendId(simDeviceSetClass, "defaultSetPath");
  id deviceSetAlloc = SendId(simDeviceSetClass, "alloc");
  id deviceSet = SendIdArgArg(deviceSetAlloc, "initWithSetPath:serviceContext:", defaultSetPath, serviceContext);
  if (!deviceSet) {
    fprintf(stderr, "Failed to create SimDeviceSet\n");
    return nil;
  }

  NSError *subscribeError = nil;
  if ([deviceSet respondsToSelector:sel_registerName("subscribeToNotificationsWithError:")]) {
    SendBoolArgError(deviceSet, "subscribeToNotificationsWithError:", nil, &subscribeError);
  }
  if (subscribeError != nil) {
    fprintf(stderr, "subscribeToNotificationsWithError failed: %s\n", DescribeObject(subscribeError).UTF8String);
  }

  id devices = SendId(deviceSet, "devices");
  for (id device in devices) {
    NSString *deviceUDID = DescribeObject(ValueForKeySafe(device, @"UDID"));
    NSNumber *state = ValueForKeySafe(device, @"state");
    if (![deviceUDID isEqualToString:udid]) continue;
    if (state != nil && state.intValue != 3) {
      fprintf(stderr, "Device %s is not booted (state=%s)\n", udid.UTF8String, DescribeObject(state).UTF8String);
      return nil;
    }
    return device;
  }

  fprintf(stderr, "UDID not found in device set: %s\n", udid.UTF8String);
  return nil;
}

static IOSurfaceRef CopyFramebufferSurface(id device, int *widthOut, int *heightOut) {
  id io = SendId(device, "io");
  id ioPorts = ValueForKeySafe(io, @"ioPorts");
  for (id port in ioPorts) {
    if (![port respondsToSelector:sel_registerName("descriptor")]) continue;
    id descriptor = SendId(port, "descriptor");
    if (![descriptor respondsToSelector:sel_registerName("framebufferSurface")]) continue;

    id surfaceObj = SendId(descriptor, "framebufferSurface");
    if (!surfaceObj) continue;

    IOSurfaceRef surface = (__bridge IOSurfaceRef)surfaceObj;
    CFRetain(surface);
    if (widthOut) *widthOut = (int)IOSurfaceGetWidth(surface);
    if (heightOut) *heightOut = (int)IOSurfaceGetHeight(surface);
    return surface;
  }

  return nil;
}

static id FindFramebufferDescriptor(id device) {
  id io = SendId(device, "io");
  id ioPorts = ValueForKeySafe(io, @"ioPorts");
  for (id port in ioPorts) {
    if (![port respondsToSelector:sel_registerName("descriptor")]) continue;
    id descriptor = SendId(port, "descriptor");
    if ([descriptor respondsToSelector:sel_registerName("framebufferSurface")]) {
      id surfaceObj = SendId(descriptor, "framebufferSurface");
      if (surfaceObj) return descriptor;
    }
  }
  return nil;
}

static void DestroyHIDContext(HIDContext *context) {
  if (!context) return;
  context->hidClient = nil;
  context->buttonFn = NULL;
  context->keyboardFn = NULL;
  context->mouseFn = NULL;
}

static BOOL CreateHIDContext(id device, HIDContext *context, NSError **error) {
  if (!context) return NO;
  context->hidClient = nil;
  context->buttonFn = NULL;
  context->keyboardFn = NULL;
  context->mouseFn = NULL;

  const char *simulatorKitPath =
      "/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit";
  void *simKitHandle = dlopen(simulatorKitPath, RTLD_NOW);
  if (!simKitHandle) {
    if (error) {
      *error = [NSError errorWithDomain:@"ios-sim-server"
                                   code:20
                               userInfo:@{
                                 NSLocalizedDescriptionKey: @"Failed to load SimulatorKit.framework",
                                 @"dlerror": [NSString stringWithUTF8String:dlerror() ?: ""],
                               }];
    }
    return NO;
  }

  context->buttonFn = (IndigoButtonMessageFn)dlsym(simKitHandle, "IndigoHIDMessageForButton");
  context->keyboardFn = (IndigoKeyboardMessageFn)dlsym(simKitHandle, "IndigoHIDMessageForKeyboardNSEvent");
  context->mouseFn = (IndigoMouseMessageFn)dlsym(simKitHandle, "IndigoHIDMessageForMouseNSEvent");
  if (!context->buttonFn || !context->keyboardFn || !context->mouseFn) {
    if (error) {
      *error = [NSError errorWithDomain:@"ios-sim-server"
                                   code:21
                               userInfo:@{NSLocalizedDescriptionKey: @"Required IndigoHID symbols are missing"}];
    }
    return NO;
  }

  Class hidClientClass = NSClassFromString(@"SimDeviceLegacyHIDClient");
  if (!hidClientClass) {
    hidClientClass = NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient");
  }
  if (!hidClientClass) {
    if (error) {
      *error = [NSError errorWithDomain:@"ios-sim-server"
                                   code:22
                               userInfo:@{NSLocalizedDescriptionKey: @"SimDeviceLegacyHIDClient class is unavailable"}];
    }
    return NO;
  }

  NSError *hidError = nil;
  id hidClient = SendIdArgError(SendId(hidClientClass, "alloc"), "initWithDevice:error:", device, &hidError);
  if (!hidClient || hidError != nil) {
    if (error) *error = hidError;
    return NO;
  }

  context->hidClient = hidClient;
  return YES;
}

static BOOL SendHIDMessage(HIDContext *context, IndigoMessage *message, NSError **error) {
  if (!context || !context->hidClient || !message) {
    if (error) {
      *error = [NSError errorWithDomain:@"ios-sim-server"
                                   code:23
                               userInfo:@{NSLocalizedDescriptionKey: @"HID client is not initialized"}];
    }
    return NO;
  }
  SendMessageFreeQueueCompletion(
      context->hidClient,
      "sendWithMessage:freeWhenDone:completionQueue:completion:",
      message,
      YES,
      nil,
      nil);
  return YES;
}

static IndigoMessage *CreateTouchMessage(HIDContext *context, CGPoint point, IndigoButtonEventType direction) {
  if (!context || !context->mouseFn) return NULL;
  IndigoMessage *seedMessage =
      context->mouseFn(&point, NULL, IndigoButtonTargetTouchScreen, (int)direction, NO);
  if (!seedMessage) return NULL;

  seedMessage->payload.event.touch.xRatio = point.x;
  seedMessage->payload.event.touch.yRatio = point.y;

  size_t messageSize = sizeof(IndigoMessage) + sizeof(IndigoPayload);
  IndigoMessage *message = calloc(1, messageSize);
  if (!message) {
    free(seedMessage);
    return NULL;
  }

  message->innerSize = sizeof(IndigoPayload);
  message->eventType = 2;
  message->payload.field1 = 0x0000000b;
  message->payload.timestamp = mach_absolute_time();
  memcpy(&(message->payload.event.button), &(seedMessage->payload.event.touch), sizeof(IndigoTouch));

  IndigoPayload *second = (IndigoPayload *)(((uint8_t *)&message->payload) + sizeof(IndigoPayload));
  memcpy(second, &(message->payload), sizeof(IndigoPayload));
  second->event.touch.field1 = 0x00000001;
  second->event.touch.field2 = 0x00000002;

  free(seedMessage);
  return message;
}

static IndigoButtonSource IndigoButtonSourceForName(NSString *buttonName) {
  NSString *lower = buttonName.lowercaseString;
  if ([lower isEqualToString:@"apple_pay"] || [lower isEqualToString:@"applepay"]) {
    return IndigoButtonSourceApplePay;
  }
  if ([lower isEqualToString:@"home"]) {
    return IndigoButtonSourceHome;
  }
  if ([lower isEqualToString:@"lock"]) {
    return IndigoButtonSourceLock;
  }
  if ([lower isEqualToString:@"side"]) {
    return IndigoButtonSourceSide;
  }
  if ([lower isEqualToString:@"siri"]) {
    return IndigoButtonSourceSiri;
  }
  return 0;
}

static BOOL SendButtonShortPress(HIDContext *context, NSString *buttonName, NSError **error) {
  IndigoButtonSource source = IndigoButtonSourceForName(buttonName);
  if (source == 0 && ![buttonName.lowercaseString isEqualToString:@"home"]) {
    if (error) {
      *error = [NSError errorWithDomain:@"ios-sim-server"
                                   code:24
                               userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"Unsupported button '%@'", buttonName ?: @""]}];
    }
    return NO;
  }

  IndigoMessage *downMessage =
      context->buttonFn((int)source, IndigoButtonEventTypeDown, IndigoButtonTargetHardware);
  IndigoMessage *upMessage =
      context->buttonFn((int)source, IndigoButtonEventTypeUp, IndigoButtonTargetHardware);
  if (!downMessage || !upMessage) {
    if (error) {
      *error = [NSError errorWithDomain:@"ios-sim-server"
                                   code:25
                               userInfo:@{NSLocalizedDescriptionKey: @"Failed to create Indigo button event"}];
    }
    if (downMessage) free(downMessage);
    if (upMessage) free(upMessage);
    return NO;
  }

  if (!SendHIDMessage(context, downMessage, error)) {
    if (upMessage) free(upMessage);
    return NO;
  }
  return SendHIDMessage(context, upMessage, error);
}

static NSString *StringForFunctionKey(unichar functionKey) {
  return [NSString stringWithCharacters:&functionKey length:1];
}

static BOOL ResolveSingleCharacterKey(NSString *key,
                                      unsigned short *keyCodeOut,
                                      NSEventModifierFlags *modifiersOut,
                                      NSString **charactersOut,
                                      NSString **charactersIgnoringModifiersOut) {
  if (key.length != 1) return NO;
  unichar c = [key characterAtIndex:0];
  NSString *characters = key;
  NSString *ignoring = key.lowercaseString;
  NSEventModifierFlags modifiers = 0;
  unsigned short keyCode = 0;

  switch (c) {
    case 'a': case 'A': keyCode = 0; break;
    case 'b': case 'B': keyCode = 11; break;
    case 'c': case 'C': keyCode = 8; break;
    case 'd': case 'D': keyCode = 2; break;
    case 'e': case 'E': keyCode = 14; break;
    case 'f': case 'F': keyCode = 3; break;
    case 'g': case 'G': keyCode = 5; break;
    case 'h': case 'H': keyCode = 4; break;
    case 'i': case 'I': keyCode = 34; break;
    case 'j': case 'J': keyCode = 38; break;
    case 'k': case 'K': keyCode = 40; break;
    case 'l': case 'L': keyCode = 37; break;
    case 'm': case 'M': keyCode = 46; break;
    case 'n': case 'N': keyCode = 45; break;
    case 'o': case 'O': keyCode = 31; break;
    case 'p': case 'P': keyCode = 35; break;
    case 'q': case 'Q': keyCode = 12; break;
    case 'r': case 'R': keyCode = 15; break;
    case 's': case 'S': keyCode = 1; break;
    case 't': case 'T': keyCode = 17; break;
    case 'u': case 'U': keyCode = 32; break;
    case 'v': case 'V': keyCode = 9; break;
    case 'w': case 'W': keyCode = 13; break;
    case 'x': case 'X': keyCode = 7; break;
    case 'y': case 'Y': keyCode = 16; break;
    case 'z': case 'Z': keyCode = 6; break;
    case '1': keyCode = 18; break;
    case '!': keyCode = 18; modifiers = NSEventModifierFlagShift; ignoring = @"1"; break;
    case '2': keyCode = 19; break;
    case '@': keyCode = 19; modifiers = NSEventModifierFlagShift; ignoring = @"2"; break;
    case '3': keyCode = 20; break;
    case '#': keyCode = 20; modifiers = NSEventModifierFlagShift; ignoring = @"3"; break;
    case '4': keyCode = 21; break;
    case '$': keyCode = 21; modifiers = NSEventModifierFlagShift; ignoring = @"4"; break;
    case '5': keyCode = 23; break;
    case '%': keyCode = 23; modifiers = NSEventModifierFlagShift; ignoring = @"5"; break;
    case '6': keyCode = 22; break;
    case '^': keyCode = 22; modifiers = NSEventModifierFlagShift; ignoring = @"6"; break;
    case '7': keyCode = 26; break;
    case '&': keyCode = 26; modifiers = NSEventModifierFlagShift; ignoring = @"7"; break;
    case '8': keyCode = 28; break;
    case '*': keyCode = 28; modifiers = NSEventModifierFlagShift; ignoring = @"8"; break;
    case '9': keyCode = 25; break;
    case '(': keyCode = 25; modifiers = NSEventModifierFlagShift; ignoring = @"9"; break;
    case '0': keyCode = 29; break;
    case ')': keyCode = 29; modifiers = NSEventModifierFlagShift; ignoring = @"0"; break;
    case '-': keyCode = 27; break;
    case '_': keyCode = 27; modifiers = NSEventModifierFlagShift; ignoring = @"-"; break;
    case '=': keyCode = 24; break;
    case '+': keyCode = 24; modifiers = NSEventModifierFlagShift; ignoring = @"="; break;
    case '[': keyCode = 33; break;
    case '{': keyCode = 33; modifiers = NSEventModifierFlagShift; ignoring = @"["; break;
    case ']': keyCode = 30; break;
    case '}': keyCode = 30; modifiers = NSEventModifierFlagShift; ignoring = @"]"; break;
    case '\\': keyCode = 42; break;
    case '|': keyCode = 42; modifiers = NSEventModifierFlagShift; ignoring = @"\\"; break;
    case ';': keyCode = 41; break;
    case ':': keyCode = 41; modifiers = NSEventModifierFlagShift; ignoring = @";"; break;
    case '\'': keyCode = 39; break;
    case '"': keyCode = 39; modifiers = NSEventModifierFlagShift; ignoring = @"'"; break;
    case '`': keyCode = 50; break;
    case '~': keyCode = 50; modifiers = NSEventModifierFlagShift; ignoring = @"`"; break;
    case ',': keyCode = 43; break;
    case '<': keyCode = 43; modifiers = NSEventModifierFlagShift; ignoring = @","; break;
    case '.': keyCode = 47; break;
    case '>': keyCode = 47; modifiers = NSEventModifierFlagShift; ignoring = @"."; break;
    case '/': keyCode = 44; break;
    case '?': keyCode = 44; modifiers = NSEventModifierFlagShift; ignoring = @"/"; break;
    case ' ': keyCode = 49; ignoring = @" "; break;
    default:
      return NO;
  }

  if ([[NSCharacterSet uppercaseLetterCharacterSet] characterIsMember:c]) {
    modifiers |= NSEventModifierFlagShift;
  }

  if (keyCodeOut) *keyCodeOut = keyCode;
  if (modifiersOut) *modifiersOut = modifiers;
  if (charactersOut) *charactersOut = characters;
  if (charactersIgnoringModifiersOut) *charactersIgnoringModifiersOut = ignoring;
  return YES;
}

static BOOL ResolveKeyboardEventSpec(NSString *key,
                                     unsigned short *keyCodeOut,
                                     NSEventModifierFlags *modifiersOut,
                                     NSString **charactersOut,
                                     NSString **charactersIgnoringModifiersOut) {
  if (ResolveSingleCharacterKey(key, keyCodeOut, modifiersOut, charactersOut, charactersIgnoringModifiersOut)) {
    return YES;
  }

  struct NamedKeySpec {
    __unsafe_unretained NSString *name;
    unsigned short keyCode;
    unichar functionKey;
  };
  static const struct NamedKeySpec namedKeys[] = {
      {@"Enter", 36, '\r'},
      {@"Tab", 48, '\t'},
      {@"Escape", 53, 0x001b},
      {@"Backspace", 51, 0x0008},
      {@"Delete", 117, NSDeleteFunctionKey},
      {@"ArrowLeft", 123, NSLeftArrowFunctionKey},
      {@"ArrowRight", 124, NSRightArrowFunctionKey},
      {@"ArrowDown", 125, NSDownArrowFunctionKey},
      {@"ArrowUp", 126, NSUpArrowFunctionKey},
      {@"Home", 115, NSHomeFunctionKey},
      {@"End", 119, NSEndFunctionKey},
      {@"PageUp", 116, NSPageUpFunctionKey},
      {@"PageDown", 121, NSPageDownFunctionKey},
      {@"Insert", 114, NSInsertFunctionKey},
      {@"F1", 122, NSF1FunctionKey},
      {@"F2", 120, NSF2FunctionKey},
      {@"F3", 99, NSF3FunctionKey},
      {@"F4", 118, NSF4FunctionKey},
      {@"F5", 96, NSF5FunctionKey},
      {@"F6", 97, NSF6FunctionKey},
      {@"F7", 98, NSF7FunctionKey},
      {@"F8", 100, NSF8FunctionKey},
      {@"F9", 101, NSF9FunctionKey},
      {@"F10", 109, NSF10FunctionKey},
      {@"F11", 103, NSF11FunctionKey},
      {@"F12", 111, NSF12FunctionKey},
  };

  for (size_t i = 0; i < sizeof(namedKeys) / sizeof(namedKeys[0]); i++) {
    if (![key isEqualToString:namedKeys[i].name]) continue;
    NSString *chars = StringForFunctionKey(namedKeys[i].functionKey);
    if (keyCodeOut) *keyCodeOut = namedKeys[i].keyCode;
    if (modifiersOut) *modifiersOut = 0;
    if (charactersOut) *charactersOut = chars;
    if (charactersIgnoringModifiersOut) *charactersIgnoringModifiersOut = chars;
    return YES;
  }

  return NO;
}

static BOOL SendKeyboardShortPress(HIDContext *context, NSString *key, NSError **error) {
  if (!context || !context->keyboardFn) {
    if (error) {
      *error = [NSError errorWithDomain:@"ios-sim-server"
                                   code:26
                               userInfo:@{NSLocalizedDescriptionKey: @"Keyboard HID is not initialized"}];
    }
    return NO;
  }

  unsigned short keyCode = 0;
  NSEventModifierFlags modifiers = 0;
  NSString *characters = nil;
  NSString *charactersIgnoringModifiers = nil;
  if (!ResolveKeyboardEventSpec(key, &keyCode, &modifiers, &characters, &charactersIgnoringModifiers)) {
    if (error) {
      *error = [NSError errorWithDomain:@"ios-sim-server"
                                   code:27
                               userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"Unsupported key '%@'", key ?: @""]}];
    }
    return NO;
  }

  NSEvent *downEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
                                        location:NSZeroPoint
                                   modifierFlags:modifiers
                                       timestamp:0
                                    windowNumber:0
                                         context:nil
                                      characters:characters
                     charactersIgnoringModifiers:charactersIgnoringModifiers
                                       isARepeat:NO
                                         keyCode:keyCode];
  NSEvent *upEvent = [NSEvent keyEventWithType:NSEventTypeKeyUp
                                      location:NSZeroPoint
                                 modifierFlags:modifiers
                                     timestamp:0
                                  windowNumber:0
                                       context:nil
                                    characters:characters
                   charactersIgnoringModifiers:charactersIgnoringModifiers
                                     isARepeat:NO
                                       keyCode:keyCode];
  IndigoMessage *downMessage = context->keyboardFn(downEvent);
  IndigoMessage *upMessage = context->keyboardFn(upEvent);
  if (!downMessage || !upMessage) {
    if (error) {
      *error = [NSError errorWithDomain:@"ios-sim-server"
                                   code:28
                               userInfo:@{NSLocalizedDescriptionKey: @"Failed to create Indigo keyboard event"}];
    }
    if (downMessage) free(downMessage);
    if (upMessage) free(upMessage);
    return NO;
  }

  if (!SendHIDMessage(context, downMessage, error)) {
    if (upMessage) free(upMessage);
    return NO;
  }
  return SendHIDMessage(context, upMessage, error);
}

static BOOL HandleControlPayload(NSData *payload, HIDContext *hidContext, NSError **error) {
  if (payload.length == 0) {
    return YES;
  }

  id json = [NSJSONSerialization JSONObjectWithData:payload options:0 error:error];
  if (!json || ![json isKindOfClass:[NSDictionary class]]) {
    return NO;
  }

  NSString *cmd = json[@"cmd"];
  if (![cmd isKindOfClass:[NSString class]]) {
    return YES;
  }

  if ([cmd isEqualToString:@"touch"]) {
    NSArray *touches = json[@"touches"];
    if (![touches isKindOfClass:[NSArray class]] || touches.count == 0) {
      return YES;
    }
    NSDictionary *touch = touches.firstObject;
    if (![touch isKindOfClass:[NSDictionary class]]) {
      return YES;
    }
    NSNumber *x = touch[@"x"];
    NSNumber *y = touch[@"y"];
    NSNumber *pressure = touch[@"pressure"];
    if (![x isKindOfClass:[NSNumber class]] || ![y isKindOfClass:[NSNumber class]]) {
      return YES;
    }
    CGPoint point = CGPointMake(fmax(0.0, fmin(1.0, x.doubleValue)), fmax(0.0, fmin(1.0, y.doubleValue)));
    IndigoButtonEventType direction =
        (pressure != nil && pressure.doubleValue <= 0.0) ? IndigoButtonEventTypeUp : IndigoButtonEventTypeDown;
    IndigoMessage *message = CreateTouchMessage(hidContext, point, direction);
    if (!message) {
      if (error) {
        *error = [NSError errorWithDomain:@"ios-sim-server"
                                     code:29
                                 userInfo:@{NSLocalizedDescriptionKey: @"Failed to create Indigo touch event"}];
      }
      return NO;
    }
    return SendHIDMessage(hidContext, message, error);
  }

  if ([cmd isEqualToString:@"key"]) {
    NSString *key = json[@"key"];
    if (![key isKindOfClass:[NSString class]] || key.length == 0) {
      return YES;
    }
    if ([key isEqualToString:@"GoHome"]) {
      return SendButtonShortPress(hidContext, @"home", error);
    }
    return SendKeyboardShortPress(hidContext, key, error);
  }

  if ([cmd isEqualToString:@"button"]) {
    NSString *button = json[@"button"];
    if (![button isKindOfClass:[NSString class]] || button.length == 0) {
      button = json[@"name"];
    }
    if (![button isKindOfClass:[NSString class]] || button.length == 0) {
      return YES;
    }
    return SendButtonShortPress(hidContext, button, error);
  }

  return YES;
}

static BOOL RunBenchmarkMode(NSString *udid, NSString *outputPath, int frameCount) {
  id device = FindBootedDevice(udid);
  if (!device) {
    return NO;
  }

  int width = 0;
  int height = 0;
  IOSurfaceRef surface = CopyFramebufferSurface(device, &width, &height);
  if (surface == nil) {
    fprintf(stderr, "Could not resolve framebufferSurface for device %s\n", udid.UTF8String);
    return NO;
  }

  CVPixelBufferRef pixelBuffer = NULL;
  NSDictionary *attrs = @{
    (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
    (id)kCVPixelBufferMetalCompatibilityKey: @YES,
  };
  CVReturn cvStatus = CVPixelBufferCreateWithIOSurface(
      kCFAllocatorDefault,
      surface,
      (__bridge CFDictionaryRef)attrs,
      &pixelBuffer);
  CFRelease(surface);
  if (cvStatus != kCVReturnSuccess || pixelBuffer == NULL) {
    fprintf(stderr, "CVPixelBufferCreateWithIOSurface failed: %d\n", cvStatus);
    return NO;
  }

  NSError *encoderError = nil;
  JPEGEncoder encoder = {0};
  if (!CreateJPEGEncoder(width, height, &encoder, &encoderError)) {
    CVPixelBufferRelease(pixelBuffer);
    fprintf(stderr, "JPEG encoder creation failed: %s\n", DescribeObject(encoderError).UTF8String);
    return NO;
  }

  NSData *lastJPEG = nil;
  NSUInteger totalBytes = 0;
  CFAbsoluteTime startTime = CFAbsoluteTimeGetCurrent();

  for (int i = 0; i < frameCount; i++) {
    NSError *encodeError = nil;
    @autoreleasepool {
      NSData *jpegData = EncodeJPEG(&encoder, pixelBuffer, &encodeError);
      if (jpegData == nil) {
        DestroyJPEGEncoder(&encoder);
        CVPixelBufferRelease(pixelBuffer);
        fprintf(stderr, "JPEG encode failed on frame %d: %s\n", i + 1, DescribeObject(encodeError).UTF8String);
        return NO;
      }
      totalBytes += jpegData.length;
      lastJPEG = jpegData;
    }
  }

  CFAbsoluteTime elapsed = CFAbsoluteTimeGetCurrent() - startTime;
  DestroyJPEGEncoder(&encoder);
  CVPixelBufferRelease(pixelBuffer);

  if (![outputPath isEqualToString:@"-"]) {
    NSError *writeError = nil;
    BOOL wrote = [lastJPEG writeToFile:outputPath options:NSDataWritingAtomic error:&writeError];
    if (!wrote) {
      fprintf(stderr, "Failed to write JPEG: %s\n", DescribeObject(writeError).UTF8String);
      return NO;
    }
    printf("wrote %s (%lu bytes) %dx%d\n", outputPath.UTF8String, (unsigned long)lastJPEG.length, width, height);
  }

  double fps = elapsed > 0 ? ((double)frameCount / elapsed) : 0.0;
  double avgMs = frameCount > 0 ? ((elapsed * 1000.0) / (double)frameCount) : 0.0;
  unsigned long avgBytes =
      frameCount > 0 ? (unsigned long)(totalBytes / (NSUInteger)frameCount) : 0;
  printf("frames=%d elapsed=%.3fs fps=%.2f avg=%.2fms avgBytes=%lu\n",
         frameCount,
         elapsed,
         fps,
         avgMs,
         avgBytes);
  return YES;
}

static BOOL RunDaemonMode(NSString *udid) {
  id device = FindBootedDevice(udid);
  if (!device) {
    return NO;
  }

  HIDContext hidContext = {0};
  NSError *hidError = nil;
  if (!CreateHIDContext(device, &hidContext, &hidError)) {
    fprintf(stderr, "Failed to create HID context: %s\n", DescribeObject(hidError).UTF8String);
    return NO;
  }

  int width = 0;
  int height = 0;
  IOSurfaceRef surface = CopyFramebufferSurface(device, &width, &height);
  if (surface == nil) {
    DestroyHIDContext(&hidContext);
    fprintf(stderr, "Could not resolve framebufferSurface for device %s\n", udid.UTF8String);
    return NO;
  }

  CVPixelBufferRef pixelBuffer = NULL;
  NSDictionary *attrs = @{
    (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
    (id)kCVPixelBufferMetalCompatibilityKey: @YES,
  };
  CVReturn cvStatus = CVPixelBufferCreateWithIOSurface(
      kCFAllocatorDefault,
      surface,
      (__bridge CFDictionaryRef)attrs,
      &pixelBuffer);
  CFRelease(surface);
  if (cvStatus != kCVReturnSuccess || pixelBuffer == NULL) {
    DestroyHIDContext(&hidContext);
    fprintf(stderr, "CVPixelBufferCreateWithIOSurface failed: %d\n", cvStatus);
    return NO;
  }

  NSError *encoderError = nil;
  JPEGEncoder encoder = {0};
  if (!CreateJPEGEncoder(width, height, &encoder, &encoderError)) {
    CVPixelBufferRelease(pixelBuffer);
    DestroyHIDContext(&hidContext);
    fprintf(stderr, "JPEG encoder creation failed: %s\n", DescribeObject(encoderError).UTF8String);
    return NO;
  }

  NSError *handshakeError = nil;
  if (!WriteHandshake(STDOUT_FILENO, width, height, &handshakeError)) {
    DestroyJPEGEncoder(&encoder);
    CVPixelBufferRelease(pixelBuffer);
    DestroyHIDContext(&hidContext);
    fprintf(stderr, "Failed to write handshake: %s\n", DescribeObject(handshakeError).UTF8String);
    return NO;
  }

  while (YES) {
    uint8_t messageType = 0;
    NSError *readError = nil;
    if (!ReadExact(STDIN_FILENO, &messageType, 1, &readError)) {
      NSString *message = DescribeObject(readError);
      if ([message containsString:@"EOF"]) {
        break;
      }
      fprintf(stderr, "Failed to read message type: %s\n", message.UTF8String);
      DestroyJPEGEncoder(&encoder);
      CVPixelBufferRelease(pixelBuffer);
      DestroyHIDContext(&hidContext);
      return NO;
    }

    switch ((MessageType)messageType) {
      case MessageTypeFrameRequest: {
        NSError *encodeError = nil;
        NSData *jpegData = EncodeJPEG(&encoder, pixelBuffer, &encodeError);
        if (jpegData == nil) {
          fprintf(stderr, "JPEG encode failed: %s\n", DescribeObject(encodeError).UTF8String);
          DestroyJPEGEncoder(&encoder);
          CVPixelBufferRelease(pixelBuffer);
          DestroyHIDContext(&hidContext);
          return NO;
        }
        NSError *writeError = nil;
        if (!WriteLengthPrefixedMessage(STDOUT_FILENO, MessageTypeFrameResponse, jpegData, &writeError)) {
          fprintf(stderr, "Failed to write frame response: %s\n", DescribeObject(writeError).UTF8String);
          DestroyJPEGEncoder(&encoder);
          CVPixelBufferRelease(pixelBuffer);
          DestroyHIDContext(&hidContext);
          return NO;
        }
        break;
      }
      case MessageTypeControl: {
        NSMutableData *payload = nil;
        if (!ReadLengthPrefixedPayload(STDIN_FILENO, &payload, &readError)) {
          fprintf(stderr, "Failed to read control payload: %s\n", DescribeObject(readError).UTF8String);
          DestroyJPEGEncoder(&encoder);
          CVPixelBufferRelease(pixelBuffer);
          DestroyHIDContext(&hidContext);
          return NO;
        }
        NSError *controlError = nil;
        if (!HandleControlPayload(payload, &hidContext, &controlError)) {
          fprintf(stderr, "Control command failed: %s\n", DescribeObject(controlError).UTF8String);
        }
        break;
      }
      default:
        fprintf(stderr, "Unknown message type: 0x%02x\n", messageType);
        DestroyJPEGEncoder(&encoder);
        CVPixelBufferRelease(pixelBuffer);
        DestroyHIDContext(&hidContext);
        return NO;
    }
  }

  DestroyJPEGEncoder(&encoder);
  CVPixelBufferRelease(pixelBuffer);
  DestroyHIDContext(&hidContext);
  return YES;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2) {
      fprintf(stderr, "Usage:\n");
      fprintf(stderr, "  %s <SIMULATOR_UDID>\n", argv[0]);
      fprintf(stderr, "  %s --benchmark <SIMULATOR_UDID> <OUTPUT_JPEG_PATH|-> [FRAME_COUNT]\n", argv[0]);
      return 2;
    }

    if (strcmp(argv[1], "--benchmark") == 0) {
      if (argc < 4) {
        fprintf(stderr, "Usage: %s --benchmark <SIMULATOR_UDID> <OUTPUT_JPEG_PATH|-> [FRAME_COUNT]\n", argv[0]);
        return 2;
      }
      NSString *udid = [NSString stringWithUTF8String:argv[2]];
      NSString *outputPath = [NSString stringWithUTF8String:argv[3]];
      int frameCount = 1;
      if (argc >= 5) {
        frameCount = (int)strtol(argv[4], NULL, 10);
        if (frameCount <= 0) frameCount = 1;
      }
      return RunBenchmarkMode(udid, outputPath, frameCount) ? 0 : 1;
    }

    NSString *udid = [NSString stringWithUTF8String:argv[1]];
    return RunDaemonMode(udid) ? 0 : 1;
  }
}
